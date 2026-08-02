import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import clientRoutes from './routes/clients';
import planRoutes from './routes/plans';
import subscriptionRoutes from './routes/subscriptions';
import billingPeriodRoutes from './routes/billing-periods';
import dashboardRoutes from './routes/dashboard';
import schedulerRoutes from './routes/scheduler';
import whatsappRoutes from './routes/whatsapp';
import { errorHandler } from './middleware/error-handler';
import { authenticateAdmin } from './middleware/auth';
import { startScheduler } from '../infrastructure/scheduler';
import { initializeFirebase } from '../infrastructure/firebase';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

try {
  initializeFirebase();
} catch (error) {
  console.error('[Firebase] Error inicializando Firebase:', error);
  process.exit(1);
}

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({
    message: 'API de Gestión de Suscripciones',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      clients: '/api/clients',
      plans: '/api/plans',
      subscriptions: '/api/subscriptions',
      billingPeriods: '/api/billing-periods',
      whatsapp: '/api/whatsapp',
    },
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', authenticateAdmin, dashboardRoutes);
app.use('/api/clients', authenticateAdmin, clientRoutes);
app.use('/api/plans', authenticateAdmin, planRoutes);
app.use('/api/subscriptions', authenticateAdmin, subscriptionRoutes);
app.use('/api/billing-periods', authenticateAdmin, billingPeriodRoutes);
app.use('/api/scheduler', authenticateAdmin, schedulerRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/communications', whatsappRoutes);

app.use(errorHandler);

app.listen(PORT, async () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  await startScheduler();
});

export default app;
