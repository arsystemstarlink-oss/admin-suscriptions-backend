# Checklist de Despliegue

## Variables de Entorno

Crear archivo `.env` basado en `.env.example`:

```bash
# Puerto del servidor
PORT=3000

# Origen permitido para CORS (frontend)
CORS_ORIGIN=https://tu-frontend.example.com

# Número de saltos de proxy inverso a confiar (Railway/Heroku: 1).
# Obligatorio cuando el deploy está detrás de un proxy para que el rate
# limiting use la IP real (X-Forwarded-For) y no falle con ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
TRUST_PROXY=1

# Configuración del cron job (formato cron)
# Por defecto: diariamente a las 00:00
CRON_SCHEDULE=0 0 * * *

# Zona horaria en la que se interpreta CRON_SCHEDULE / la expresión del scheduler
# Por defecto: America/Caracas (UTC-4). Sin esta variable, el cron usa la hora del servidor (generalmente UTC).
SCHEDULER_TIMEZONE=America/Caracas

# Entorno de ejecución
NODE_ENV=production

# Ruta a credenciales de Firebase
FIREBASE_CREDENTIALS_PATH=./api-gestion-starlink-firebase-adminsdk-fbsvc-a7cdd010e2.json

# Secreto para firmar tokens JWT (mínimo 32 caracteres, obligatorio)
# En production no se acepta el valor de ejemplo "change-this-in-production"
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production-min-32-chars

# Clave para crear el PRIMER admin desde el frontend (POST /api/auth/setup).
# Solo funciona mientras no exista ningún admin. Generar con: openssl rand -hex 32
# Los admins adicionales se crean con POST /api/auth/register (requiere JWT de admin).
SETUP_KEY=

# URL pública del backend (usada para validar firmas de webhooks de Twilio)
BASE_URL=https://tu-api.example.com

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
# En development se puede desactivar con false.
# En production la validación de firma del webhook es siempre obligatoria.
TWILIO_WEBHOOK_VALIDATION=true

# Web Push (notificaciones push del navegador). Generar el par de llaves con:
#   npx web-push generate-vapid-keys --json
# La llave privada nunca debe exponerse.
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@tu-dominio.com
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
curl http://localhost:3000/health
```

**Respuesta esperada (`/`):**
```json
{
  "message": "API de Gestión de Suscripciones",
  "version": "1.0.0",
  "endpoints": {
    "auth": "/api/auth",
    "clients": "/api/clients",
    "plans": "/api/plans",
    "subscriptions": "/api/subscriptions",
    "billingPeriods": "/api/billing-periods",
    "whatsapp": "/api/whatsapp",
    "dashboard": "/api/dashboard",
    "scheduler": "/api/scheduler"
  }
}
```

### 2. Crear usuario administrador

Hay dos formas:

**Opción A - Desde el frontend (recomendada):**
```bash
curl -X POST http://localhost:3000/api/auth/setup \
  -H "Content-Type: application/json" \
  -H "X-Setup-Key: TU_SETUP_KEY" \
  -d '{"name": "Admin", "email": "admin@example.com", "password": "MiPasswordSegura123!", "phone": "+584123456789"}'
```
- `SETUP_KEY` debe estar configurado en `.env`
- Solo funciona mientras no exista ningún admin
- Los admins adicionales se crean con `POST /api/auth/register` (requiere JWT de un admin existente)

**Opción B - Script CLI (solo uso operativo/dev):**
```bash
npm run create-admin "Admin" admin@example.com "TuPasswordSegura123!" "+584123456789"
```

**Importante:** Guarda la contraseña. No se podrá recuperar después.

> **Seguridad del script en repositorios públicos:** `scripts/create-admin.ts` no contiene secretos. Las credenciales reales están en `.env` y en `api-gestion-starlink-firebase-adminsdk-*.json`, ambos ignorados por git (`.gitignore`) y nunca commiteados. Sin esas credenciales el script es inerte. No subas `.env` ni el JSON de Firebase a ningún repositorio.

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

**Respuesta esperada:** lista paginada de clientes (vacía al inicio)

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
Los logs se muestran en la consola. No se registran headers/body completos de webhooks ni payloads sensibles de Twilio.

### Producción con PM2
```bash
# Ver logs en tiempo real
pm2 logs subscription-api

# Ver logs de un archivo específico
pm2 logs subscription-api --lines 100
```

## Monitoreo

### Health Check
```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "timestamp": "2026-08-12T00:00:00.000Z",
  "uptime": 123.45
}
```

### Métricas recomendadas
- Tiempo de respuesta de endpoints
- Tasa de errores 4xx y 5xx
- Uso de memoria
- Estado del scheduler
- Intentos de login rate-limited

## Backup

### Persistencia con Firebase Firestore
El sistema usa Firebase Firestore para persistencia de datos. Los datos se mantienen entre reinicios.

### Colecciones de Firebase
- `clients` - Clientes del sistema
- `plans` - Planes de suscripción
- `subscriptions` - Suscripciones activas
- `billingPeriods` - Períodos de facturación
- `users` - Usuarios administradores
- `refreshTokenSessions` - Sesiones de refresh token (rotación/revocación)
- `whatsappMessages` - Historial de mensajes WhatsApp
- `schedulerConfig` - Configuración del cron job

### Reglas de Firestore
Como el backend usa Firebase Admin SDK, el acceso a datos no pasa por las reglas del cliente. Aun así, en la consola de Firebase las reglas de la base de datos deben denegar acceso público de lectura/escritura (especialmente la colección `users` con hashes bcrypt).

## Seguridad

### Controles implementados
- JWT obligatorio en todas las rutas de negocio (`/api/clients`, `/api/plans`, `/api/subscriptions`, `/api/billing-periods`, `/api/dashboard`, `/api/scheduler`)
- WhatsApp protegido: `POST /api/whatsapp/send` y `GET /api/whatsapp/messages/:phone` requieren admin JWT
- Webhook público solo en `POST /communications/webhook` (y alias bajo `/api/whatsapp/webhook`)
- Validación de firma Twilio: obligatoria en production; en development se puede desactivar con `TWILIO_WEBHOOK_VALIDATION=false`
- Access y refresh tokens con claim `type` distinto (un access token no sirve como refresh) y `sub` (userId)
- Refresh tokens de un solo uso: rotación en cada refresh, revocación en logout, y revocación de todas las sesiones si se detecta reuso (`refreshTokenSessions`)
- `POST /auth/logout` revoca el refresh token presentado (logout por sesión)
- Middleware verifica `role === 'admin'`
- `JWT_SECRET` obligatorio (mín. 32 chars); en production se rechaza el valor de ejemplo
- Rate limits: `POST /api/auth/login` (20 intentos / 15 min), `POST /api/auth/refresh` (60 / 15 min) y `POST /api/auth/setup` (5 / 15 min)
- Creación de admin: primer admin vía `POST /api/auth/setup` con clave `SETUP_KEY` (solo sin admins existentes); admins adicionales vía `POST /api/auth/register` con JWT de admin
- Helmet para headers HTTP de seguridad
- Límite de body JSON a 1mb
- CORS restringido por `CORS_ORIGIN`
- Edición de perfil: email normalizado a minúsculas + unicidad + requiere contraseña actual; phone normalizado a E.164 (+58)
- Cambio de contraseña valida la actual, exige contraseña fuerte (mín. 8, letras y números) y revoca sesiones previas
- El DTO de usuario nunca expone `password` ni hashes de tokens

### Checklist de seguridad
- [ ] JWT_SECRET es suficientemente largo y aleatorio (mínimo 32 caracteres)
- [ ] JWT_SECRET no es el valor de ejemplo en production
- [ ] NODE_ENV está configurado como "production"
- [ ] CORS_ORIGIN apunta solo al dominio del frontend
- [ ] BASE_URL es la URL pública HTTPS del backend (webhooks Twilio)
- [ ] TWILIO_WEBHOOK_VALIDATION no está en false en production
- [ ] HTTPS configurado en producción (reverse proxy / load balancer)
- [ ] Logs no contienen información sensible
- [ ] Dependencias actualizadas (`npm audit`)
- [ ] Credenciales de Firebase almacenadas de forma segura (no en git)
- [ ] Reglas de Firestore deniegan acceso público
- [ ] TRUST_PROXY configurado cuando hay proxy inverso delante

### Configuración CORS
El servidor ya usa `CORS_ORIGIN` desde variables de entorno:

```bash
CORS_ORIGIN=https://tu-frontend.example.com
```

## Troubleshooting

### El scheduler no se ejecuta
1. Verificar que `CRON_SCHEDULE` está configurado correctamente
2. Revisar logs del servidor
3. Verificar que el servidor no se reinició antes de la ejecución programada

### Errores de autenticación JWT
1. Verificar que el token no haya expirado (15 minutos para access token)
2. Usar el refresh token (`POST /api/auth/refresh`) para obtener un nuevo access token
3. Verificar que el header sea `Authorization: Bearer {token}`
4. Asegurar que no hay espacios extra en el token
5. Confirmar que `JWT_SECRET` es el mismo con el que se firmaron los tokens

### Rate limit en login (`429`)
1. Esperar la ventana de 15 minutos o reiniciar el proceso en desarrollo
2. Revisar intentos automatizados o credenciales incorrectas repetidas

### Error `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`
El deploy está detrás de un proxy inverso (Railway/Heroku) y Express no confía en `X-Forwarded-For`:

1. Verificar que `TRUST_PROXY=1` está configurado (o el número de saltos de tu proveedor)
2. Redesplegar; el servidor usa `app.set('trust proxy', ...)` automáticamente

### Error `JWT_SECRET must be changed from the default value in production`
El `JWT_SECRET` en producción es el valor de ejemplo:

1. Generar uno nuevo: `openssl rand -hex 32`
2. Configurarlo en las variables de entorno del proveedor (Railway → Variables → JWT_SECRET)
3. Redesplegar. No se acepta el valor de ejemplo a propósito; sin esto, el login falla.

### Webhook de Twilio rechazado (`INVALID_WEBHOOK`)
1. Verificar `TWILIO_AUTH_TOKEN`
2. Verificar que `BASE_URL` coincide exactamente con la URL configurada en Twilio Console
3. En development, solo si es necesario: `TWILIO_WEBHOOK_VALIDATION=false`

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
1. Revisar `api-contract.md` para documentación de endpoints
2. Revisar `plan.md` para arquitectura y reglas de negocio
3. Revisar `document-proyect.md` para requisitos del sistema
4. Revisar `WHATSAPP_TEMPLATES.md` para integración de WhatsApp
