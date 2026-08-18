import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admins';
import clientRoutes from './routes/clients';
import planRoutes from './routes/plans';
import subscriptionRoutes from './routes/subscriptions';
import billingPeriodRoutes from './routes/billing-periods';
import dashboardRoutes from './routes/dashboard';
import schedulerRoutes from './routes/scheduler';
import whatsappRoutes from './routes/whatsapp';
import pushRoutes from './routes/push';
import { errorHandler } from './middleware/error-handler';
import { authenticateAdmin } from './middleware/auth';
import { startScheduler } from '../infrastructure/scheduler';
import { initializeFirebase } from '../infrastructure/firebase';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Detrás de un proxy inverso (Railway, Heroku, etc.) Express debe confiar en
// el primer salto para leer X-Forwarded-For y que express-rate-limit pueda
// identificar la IP real del cliente.
const trustProxy = process.env.TRUST_PROXY ?? '1';
app.set('trust proxy', trustProxy === 'false' ? false : Number(trustProxy));

try {
  initializeFirebase();
} catch (error) {
  console.error('[Firebase] Error inicializando Firebase:', error);
  process.exit(1);
}

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Demasiados intentos de login. Intenta de nuevo más tarde.',
    },
  },
});

const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Demasiadas solicitudes de renovación. Intenta de nuevo más tarde.',
    },
  },
});

const setupRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Demasiados intentos de setup. Intenta de nuevo más tarde.',
    },
  },
});

app.get('/', (req, res) => {
  res.json({
    message: 'API de Gestión de Suscripciones',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      admins: '/api/admins',
      clients: '/api/clients',
      plans: '/api/plans',
      subscriptions: '/api/subscriptions',
      billingPeriods: '/api/billing-periods',
      whatsapp: '/api/whatsapp',
      dashboard: '/api/dashboard',
      scheduler: '/api/scheduler',
      push: '/api/push',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.use('/api/auth/login', loginRateLimiter);
app.use('/api/auth/refresh', refreshRateLimiter);
app.use('/api/auth/setup', setupRateLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/admins', authenticateAdmin, adminRoutes);
app.use('/api/dashboard', authenticateAdmin, dashboardRoutes);
app.use('/api/clients', authenticateAdmin, clientRoutes);
app.use('/api/plans', authenticateAdmin, planRoutes);
app.use('/api/subscriptions', authenticateAdmin, subscriptionRoutes);
app.use('/api/billing-periods', authenticateAdmin, billingPeriodRoutes);
app.use('/api/scheduler', authenticateAdmin, schedulerRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/communications', whatsappRoutes);
app.use('/api/push', pushRoutes);

app.use(errorHandler);

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  await startScheduler();
});

function shutdown(signal: string): void {
  console.log(`[Server] Recibida señal ${signal}. Cerrando servidor...`);
  server.close(() => {
    console.log('[Server] Servidor cerrado limpiamente.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[Server] Cierre forzado por timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
