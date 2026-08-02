# Checklist de Despliegue

## Variables de Entorno

Crear archivo `.env` basado en `.env.example`:

```bash
# Puerto del servidor
PORT=3000

# Configuración del cron job (formato cron)
# Por defecto: diariamente a las 00:00
CRON_SCHEDULE=0 0 * * *

# Entorno de ejecución
NODE_ENV=production

# Ruta a credenciales de Firebase
FIREBASE_CREDENTIALS_PATH=./api-gestion-starlink-firebase-adminsdk-fbsvc-a7cdd010e2.json

# Secreto para firmar tokens JWT (mínimo 32 caracteres)
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production-min-32-chars
```

### Generar JWT_SECRET seguro

```bash
# Linux/Mac
openssl rand -hex 32

# Windows PowerShell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | % {[char]$_})
```

## Instalación

```bash
# Instalar dependencias
npm install

# Compilar TypeScript
npm run build

# Ejecutar tests
npm test
```

## Ejecución

### Desarrollo
```bash
npm run dev
```

### Producción
```bash
npm run build
npm start
```

### Con PM2 (recomendado para producción)
```bash
# Instalar PM2 globalmente
npm install -g pm2

# Iniciar aplicación
pm2 start dist/server.js --name subscription-api

# Configurar inicio automático
pm2 startup
pm2 save
```

## Verificación Post-Despliegue

### 1. Verificar que el servidor responde
```bash
curl http://localhost:3000/
```

**Respuesta esperada:**
```json
{
  "message": "API de Gestión de Suscripciones",
  "version": "1.0.0",
  "endpoints": {
    "auth": "/api/auth",
    "clients": "/api/clients",
    "plans": "/api/plans",
    "subscriptions": "/api/subscriptions",
    "billingPeriods": "/api/billing-periods"
  }
}
```

### 2. Crear usuario administrador
```bash
npm run create-admin "Admin" admin@example.com
```

Esto creará el usuario, generará una contraseña aleatoria y tokens JWT automáticamente.

**Importante:** Guarda la contraseña que se muestra en la consola. No se podrá recuperar después.

### 3. Verificar autenticación con JWT
```bash
# Primero obtener token
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "password": "your-password-here"}'

# Luego usar el token
curl http://localhost:3000/api/clients \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Respuesta esperada:** `[]` (lista vacía)

### 4. Verificar scheduler
Revisar logs para confirmar que el scheduler está activo:
```
[Scheduler] Daily Job programado con cron: 0 0 * * *
```

## Configuración de Firewall

Asegurar que el puerto configurado (default: 3000) está abierto:

```bash
# Linux (ufw)
sudo ufw allow 3000/tcp

# Windows (PowerShell como administrador)
New-NetFirewallRule -DisplayName "Subscription API" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

## Logs

### Desarrollo
Los logs se muestran en la consola.

### Producción con PM2
```bash
# Ver logs en tiempo real
pm2 logs subscription-api

# Ver logs de un archivo específico
pm2 logs subscription-api --lines 100
```

## Monitoreo

### Health Check
Implementar endpoint de health check:

```typescript
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});
```

### Métricas recomendadas
- Tiempo de respuesta de endpoints
- Tasa de errores 4xx y 5xx
- Uso de memoria
- Estado del scheduler

## Backup

### Persistencia con Firebase Firestore
El sistema usa Firebase Firestore para persistencia de datos. Los datos se mantienen entre reinicios.

### Colecciones de Firebase
- `clients` - Clientes del sistema
- `plans` - Planes de suscripción
- `subscriptions` - Suscripciones activas
- `billingPeriods` - Períodos de facturación
- `users` - Usuarios administradores

## Seguridad

### Checklist de seguridad
- [ ] JWT_SECRET es suficientemente largo y aleatorio (mínimo 32 caracteres)
- [ ] NODE_ENV está configurado como "production"
- [ ] CORS está configurado correctamente (solo dominios permitidos)
- [ ] Rate limiting implementado (opcional)
- [ ] HTTPS configurado en producción
- [ ] Logs no contienen información sensible
- [ ] Dependencias actualizadas (`npm audit`)
- [ ] Credenciales de Firebase almacenadas de forma segura

### Configuración CORS para producción
```typescript
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || [],
  credentials: true
};

app.use(cors(corsOptions));
```

## Troubleshooting

### El scheduler no se ejecuta
1. Verificar que `CRON_SCHEDULE` está configurado correctamente
2. Revisar logs del servidor
3. Verificar que el servidor no se reinició antes de la ejecución programada

### Errores de autenticación JWT
1. Verificar que el token no haya expirado (15 minutos para access token)
2. Usar el refresh token para obtener un nuevo access token
3. Verificar que el header sea `Authorization: Bearer {token}`
4. Asegurar que no hay espacios extra en el token

### Errores de Firebase
1. Verificar que `FIREBASE_CREDENTIALS_PATH` apunta al archivo correcto
2. Verificar que el archivo de credenciales existe y tiene permisos de lectura
3. Verificar que el proyecto de Firebase está activo

### TypeScript compilation errors
```bash
# Limpiar y recompilar
rm -rf dist/
npm run build
```

## Soporte

Para problemas o preguntas:
1. Revisar `API-DOCS.md` para documentación de endpoints
2. Revisar `plan.md` para arquitectura y reglas de negocio
3. Revisar `document-proyect.md` para requisitos del sistema
