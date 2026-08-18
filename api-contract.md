# API Contract

## Configuracion

```
Base URL: http://localhost:3000/api
Auth: Authorization: Bearer {accessToken}
```

**Tokens:** accessToken (15 min) | refreshToken (7 dias)

**Seguridad:**
- Todas las rutas bajo `/api/*` (excepto `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout` y webhooks Twilio) requieren JWT de admin.
- Access y refresh tokens incluyen claims `type` (`access` | `refresh`), `sub` (userId) y `jti` (refresh); no son intercambiables.
- El refresh token es de un solo uso: cada `POST /auth/refresh` rota a un token nuevo y revoca el anterior (sesión persistida en `refreshTokenSessions`).
- Si se reutiliza un refresh token ya rotado/revocado, se revocan todas las sesiones del usuario (`REFRESH_TOKEN_REVOKED`).
- `POST /auth/logout` revoca el refresh token presentado (logout por sesión).
- Rate limits: `POST /api/auth/login` (20 intentos / 15 min por IP) y `POST /api/auth/refresh` (60 / 15 min por IP).
- Headers de seguridad HTTP vía Helmet.
- `POST /communications/webhook` (público) valida firma Twilio (obligatoria en production).

**Paginacion:** Todos los endpoints de lista devuelven:
```typescript
{
  [entidad]: T[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean; }
}
```

---

## Tipos

```typescript
enum PaymentMethod { CASH, TRANSFER, USDT, CARD, OTHER }
// INITIAL_PAYMENT ya no se crea en el registro; se conserva por compatibilidad con períodos existentes

enum SubscriptionStatus { ACTIVE, SUSPENDED }

enum BillingPeriodStatus { PENDING, PAID, OVERDUE }
```

### Entidades

```typescript
interface User {
  id: string; name: string; email: string;
  role: 'admin'; phone?: string; // normalizado a E.164 (+58...)
  lastLoginAt?: string;
  createdAt: string;
}

interface RefreshTokenSession {
  id: string; // jti
  userId: string;
  tokenHash: string; // sha256 del refresh token (interno, no se expone)
  createdAt: string; expiresAt: string; lastUsedAt: string;
  revokedAt?: string; replacedBy?: string;
}

interface Client {
  id: string; firstName: string; lastName: string; phone: string;
  dni?: string; // Cédula de identidad (formato canónico "V-2769383" o "J-123456789", única si existe)
  email?: string; address?: string; notes?: string;
  createdAt: string;
}

interface Plan {
  id: string; name: string; price: number;
  description: string; active: boolean; createdAt: string;
}

interface Subscription {
  id: string; clientId: string; planId: string; kitNumber: string;
  accountNumber?: string;
  billingDay: number; status: SubscriptionStatus;
  maxOverduePeriods: number; activationDate?: string; createdAt: string;
}

interface SchedulerConfig {
  id: string;
  enabled: boolean;
  cronSchedule: string;
  lastRun?: string;
  updatedAt: string;
}

interface BillingPeriod {
  id: string; subscriptionId: string; periodLabel: string;
  startDate: string; endDate: string; amount: number;
  status: BillingPeriodStatus;
  paidAt?: string; paymentMethod?: PaymentMethod; notes?: string;
  createdAt: string;
}

type MessageDirection = 'INBOUND' | 'OUTBOUND';
type MessageStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

interface WhatsAppMessage {
  id: string;
  clientId?: string;
  phone: string;
  direction: MessageDirection;
  messageSid: string;
  body: string;
  templateName?: string;
  status: MessageStatus;
  errorMessage?: string;
  profileName?: string;
  createdAt: string;
}
```

### Tipos Enriquecidos (respuestas de GET)

```typescript
interface ClientWithStats extends Client {
  subscriptionStatus: 'ACTIVE' | 'SUSPENDED' | 'MIXED' | 'NONE';
  hasDebt: boolean; overdueCount: number; totalSubscriptions: number;
}

interface SubscriptionWithDetails extends Subscription {
  client: Pick<Client, 'id' | 'firstName' | 'lastName' | 'phone' | 'dni' | 'email'>;
  plan: Pick<Plan, 'id' | 'name' | 'price'>;
  currentPeriod?: BillingPeriod;
  totalPeriods: number; overduePeriods: number;
  pendingPeriods: number; hasDebt: boolean;
}

interface BillingPeriodWithDetails extends BillingPeriod {
  subscription: Pick<Subscription, 'id' | 'kitNumber' | 'status'>;
  client: Pick<Client, 'id' | 'firstName' | 'lastName' | 'phone' | 'dni' | 'email'>;
  plan: Pick<Plan, 'id' | 'name' | 'price'>;
}

interface DashboardSummary {
  clients: { total: number };
  plans: { total: number; active: number };
  subscriptions: { total: number; active: number; suspended: number };
  billingPeriods: { total: number; paid: number; pending: number; overdue: number };
  financial: {
    monthlyIncome: number; totalIncome: number;
    totalPending: number; totalOverdue: number; totalDebt: number;
  };
  generatedAt: string;
}

interface DashboardAlerts {
  generatedAt: string;
  expiringSoon: { count: number; items: AlertItem[] };
  overdue: { totalOverduePeriods: number; totalOverdueAmount: number; suspendedSubscriptions: number };
  topDebtors: { count: number; items: DebtorItem[] };
}

interface AlertItem {
  periodId: string; periodLabel: string; amount: number; endDate: string;
  subscriptionId: string; kitNumber: string; clientName: string; clientPhone: string;
  clientDni?: string;
}

interface DebtorItem {
  clientId: string; clientName: string; clientPhone: string; clientDni?: string;
  totalDebt: number; overdueCount: number;
}
```

---

## Endpoints

### Auth

| Metodo | Path | Auth | Descripcion |
|--------|------|------|-------------|
| POST | /auth/setup | Header `X-Setup-Key` | Crear el PRIMER admin (solo sin admins existentes) |
| POST | /auth/register | Bearer admin | Crear un admin adicional |
| POST | /auth/login | - | Login |
| POST | /auth/refresh | - | Renovar tokens (rota refresh token) |
| POST | /auth/logout | - | Revocar refresh token (logout por sesión) |
| GET | /auth/me | Bearer admin | Perfil del admin logueado |
| PUT | /auth/me | Bearer admin | Editar name/email/phone |
| POST | /auth/change-password | Bearer admin | Cambiar contraseña |

**POST /auth/setup**
```typescript
// Header: X-Setup-Key: {SETUP_KEY}
// Request
{ name: string; email: string; password: string; phone?: string }
// password: mínimo 8 caracteres, letras y números
// Response 201
{ message: string; user: User }
// Solo funciona mientras NO exista ningún admin
// Errors: 403 SETUP_DISABLED (no configurado o ya hay admin) | 403 INVALID_SETUP_KEY
//         400 INVALID_EMAIL | 400 WEAK_PASSWORD | 400 INVALID_PHONE | 409 EMAIL_TAKEN
// Rate limit: 5 intentos / 15 min por IP
```

**POST /auth/register**
```typescript
// Header: Authorization: Bearer {accessToken} (admin existente)
// Request
{ name: string; email: string; password: string; phone?: string }
// Response 201
{ message: string; user: User }
// Errors: 401 UNAUTHORIZED | 400 INVALID_EMAIL | 400 WEAK_PASSWORD | 400 INVALID_PHONE | 409 EMAIL_TAKEN
```

**POST /auth/login**
```typescript
// Request
{ email: string; password: string }
// Response 200
{ accessToken: string; refreshToken: string; user: User }
// Actualiza lastLoginAt del usuario
```

**POST /auth/refresh**
```typescript
// Request
{ refreshToken: string }
// Response 200
{ accessToken: string; refreshToken: string }
// Rota el refresh token (revoca el anterior)
// Error 401: UNAUTHORIZED (inválido/expirado) | REFRESH_TOKEN_REVOKED (reuso detectado)
```

**POST /auth/logout**
```typescript
// Request
{ refreshToken: string }
// Response 204
// Revoca la sesión asociada al refresh token. Idempotente.
```

**GET /auth/me**
```typescript
// Header: Authorization: Bearer {accessToken}
// Response 200
{ user: User }
// Error 404: USER_NOT_FOUND | Error 401: UNAUTHORIZED
```

**PUT /auth/me**
```typescript
// Header: Authorization: Bearer {accessToken}
// Request (parcial, al menos un campo)
{ name?: string; email?: string; phone?: string; currentPassword?: string }
// currentPassword es obligatorio SOLO si email cambia
// phone se normaliza a E.164 (+58...)
// Response 200
{ user: User }
// Errors: 400 INVALID_EMAIL | 400 INVALID_PASSWORD | 400 INVALID_PHONE | 409 EMAIL_TAKEN
```

**POST /auth/change-password**
```typescript
// Header: Authorization: Bearer {accessToken}
// Request
{ currentPassword: string; newPassword: string }
// newPassword: mínimo 8 caracteres, letras y números
// Revoca todas las sesiones y emite un par de tokens nuevo para la sesión actual
// Response 200
{ message: string; accessToken: string; refreshToken: string }
// Errors: 400 INVALID_PASSWORD (actual incorrecta) | 400 WEAK_PASSWORD
```

---

### Administradores

| Metodo | Path | Auth | Descripcion |
|--------|------|------|-------------|
| GET | /admins | Bearer admin | Listar admins |
| GET | /admins/:id | Bearer admin | Detalle de admin |
| PUT | /admins/:id | Bearer admin | Editar otro admin |
| DELETE | /admins/:id | Bearer admin | Eliminar admin |

**GET /admins**
```typescript
// Query params
{ search?: string; limit?: number; offset?: number }
// search filtra por name, email o phone
// Response 200
{ admins: User[]; pagination }
// Ordenados por createdAt ascendente. Sin campo password.
```

**GET /admins/:id**
```typescript
// Response 200
{ admin: User }
// Error 404: NOT_FOUND | Error 401: UNAUTHORIZED
```

**PUT /admins/:id**
```typescript
// Header: Authorization: Bearer {accessToken} (admin)
// Request (parcial, al menos un campo)
{ name?: string; email?: string; phone?: string; newPassword?: string }
// No requiere currentPassword del admin editado (lo hace otro admin)
// newPassword: mínimo 8 caracteres, letras y números
// phone se normaliza a E.164 (+58...)
// Si email o newPassword cambian, se revocan todas las sesiones del admin editado
// Si el admin editado es el mismo logueado, la respuesta incluye accessToken/refreshToken nuevos
// Response 200
{ admin: User; accessToken?: string; refreshToken?: string }
// Errors: 400 INVALID_EMAIL | 400 WEAK_PASSWORD | 400 INVALID_PHONE | 409 EMAIL_TAKEN
```

**DELETE /admins/:id**
```typescript
// Header: Authorization: Bearer {accessToken} (admin)
// Response 204
// Revoca las sesiones del admin y lo elimina de Firestore y Firebase Auth
// Errors: 403 CANNOT_DELETE_SELF | 409 LAST_ADMIN (único admin del sistema)
//         404 NOT_FOUND | 401 UNAUTHORIZED
```

---

### Clientes

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | /clients | Listar clientes |
| GET | /clients/:id | Detalle de cliente |
| POST | /clients | Crear cliente |
| PUT | /clients/:id | Actualizar cliente |
| DELETE | /clients/:id | Eliminar cliente |

**GET /clients**
```typescript
// Query params
{ search?: string; include?: 'subscriptions'; subscriptionStatus?: SubscriptionStatus | 'MIXED' | 'NONE'; hasOverdue?: boolean; limit?: number; offset?: number }
// Response 200
{ clients: ClientWithStats[]; pagination }
// Si include=subscriptions: ClientWithSubscriptions[]
```

**GET /clients/:id**
```typescript
// Response 200
{
  client: Client;
  subscriptions: SubscriptionWithDetails[];
  summary: { totalSubscriptions: number; activeSubscriptions: number; suspendedSubscriptions: number; totalOverdue: number; hasDebt: boolean };
}
```

**POST /clients**
```typescript
// Request
{ firstName: string; lastName: string; phone: string; dni?: string; email?: string; address?: string; notes?: string }
// dni se normaliza a formato canónico con guion (ej: "v.12.345.678" -> "V-12345678", "V12345678" -> "V-12345678")
// dni: opcional, SOLO "V-" o "J-" + 7 a 9 dígitos numéricos. Otros formatos se rechazan (ej: "9279238239" -> INVALID_DNI)
// Response 201 → Client
// Errors: 400 INVALID_DNI | 409 DNI_TAKEN
```

**PUT /clients/:id**
```typescript
// Request (partial)
{ firstName?: string; lastName?: string; phone?: string; dni?: string | null; email?: string; address?: string; notes?: string }
// dni: null o "" elimina la cédula del cliente
// Errors: 400 INVALID_DNI | 409 DNI_TAKEN
// Response 200 → Client
```

**DELETE /clients/:id** → Response 204

---

### Planes

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | /plans | Listar planes |
| GET | /plans/:id | Detalle de plan |
| POST | /plans | Crear plan |
| PUT | /plans/:id | Actualizar plan |
| DELETE | /plans/:id | Eliminar plan |

**GET /plans**
```typescript
// Query params
{ search?: string; active?: boolean; limit?: number; offset?: number }
// Response 200
{ plans: Plan[]; pagination }
```

**GET /plans/:id** → Response 200 → `Plan`

**POST /plans**
```typescript
// Request
{ name: string; price: number; description: string; active?: boolean }
// Response 201 → Plan
```

**PUT /plans/:id**
```typescript
// Request (partial)
{ name?: string; price?: number; description?: string; active?: boolean }
// Response 200 → Plan
```

**DELETE /plans/:id** → Response 204

---

### Suscripciones

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | /subscriptions | Listar suscripciones |
| GET | /subscriptions/:id | Detalle con periodos |
| POST | /subscriptions | Crear suscripcion |
| PUT | /subscriptions/:id | Actualizar suscripcion |
| DELETE | /subscriptions/:id | Eliminar suscripcion |

**GET /subscriptions**
```typescript
// Query params
{ clientId?: string; status?: SubscriptionStatus; search?: string; hasOverduePeriods?: boolean; limit?: number; offset?: number }
// Response 200
{ subscriptions: SubscriptionWithDetails[]; pagination }
```

**GET /subscriptions/:id**
```typescript
// Response 200
{
  subscription: SubscriptionWithDetails & { plan: Plan };
  billingPeriods: BillingPeriod[];
  summary: {
    totalPeriods: number; paidPeriods: number; pendingPeriods: number;
    overduePeriods: number; totalPaid: number; totalPending: number; hasDebt: boolean;
  };
}
```

**POST /subscriptions**
```typescript
// Request
{
  clientId: string;
  planId: string;
  kitNumber: string;           // Se convierte a UPPERCASE automaticamente
  accountNumber?: string;      // Numero de cuenta Starlink (ej: "ACC-8381534-78084-24")
  billingDay: number;          // 1-28
  maxOverduePeriods: number;   // minimo 1
  activationDate?: string;     // Formato YYYY-MM-DD, no futura
  historicalPayments?: HistoricalPaymentDto[];
}
// Response 201
{ subscription: Subscription; billingPeriods: BillingPeriod[]; summary: SubscriptionSummary }
```

**PUT /subscriptions/:id**
```typescript
// Request (partial)
{ planId?: string; kitNumber?: string; accountNumber?: string; billingDay?: number; maxOverduePeriods?: number; status?: SubscriptionStatus }
// kitNumber se convierte a UPPERCASE automaticamente
// Response 200 → Subscription
```

**DELETE /subscriptions/:id** → Response 204
> Elimina tambien todos los periodos de facturacion asociados a la suscripcion.

---

### Periodos de Facturacion

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | /billing-periods | Listar periodos |
| GET | /billing-periods/:id | Detalle de periodo |
| PUT | /billing-periods/:id | Editar datos de pago |
| POST | /billing-periods/:id/pay | Registrar pago |

**GET /billing-periods**
```typescript
// Query params
{ subscriptionId?: string; clientId?: string; status?: BillingPeriodStatus; search?: string; expiresBefore?: string; limit?: number; offset?: number }
// Response 200
{ periods: BillingPeriodWithDetails[]; pagination }
```

**GET /billing-periods/:id** → Response 200 → `BillingPeriodWithDetails`

**PUT /billing-periods/:id** (solo periodos PAID)
```typescript
// Request (partial)
{ paymentMethod?: PaymentMethod; amount?: number; paidAt?: string; notes?: string }
// paidAt formato YYYY-MM-DD
// Response 200 → BillingPeriodWithDetails
```

**POST /billing-periods/:id/pay** (periodos PENDING/OVERDUE)
```typescript
// Request
{ paymentMethod: PaymentMethod; amount: number; paidAt: string; notes?: string }
// paidAt formato YYYY-MM-DD
// Response 200
{
  billingPeriod: BillingPeriod;
  subscription: { id: string; status: SubscriptionStatus; previousStatus: SubscriptionStatus; reactivated: boolean };
}
```

---

### Dashboard

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | /dashboard/summary | Resumen general |
| GET | /dashboard/alerts | Alertas y datos accionables |

**GET /dashboard/summary** → Response 200 → `DashboardSummary`

**GET /dashboard/alerts** → Response 200 → `DashboardAlerts`

---

### Scheduler

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | /scheduler/config | Obtener configuración del scheduler |
| PUT | /scheduler/config | Actualizar configuración |
| POST | /scheduler/run | Ejecutar Daily Job manualmente |

**GET /scheduler/config**
```typescript
// Response 200 → SchedulerConfig
```

**PUT /scheduler/config**
```typescript
// Request (partial)
{ enabled?: boolean; cronSchedule?: string }
// cronSchedule debe ser una expresión cron válida (ej: "0 0 * * *" para medianoche diario)
// Response 200 → SchedulerConfig
// Reprograma el scheduler automáticamente
```

**POST /scheduler/run**
```typescript
// Ejecuta el Daily Job inmediatamente (independiente del estado enabled)
// Response 200
{ message: string }
```

---

### WhatsApp

| Metodo | Path | Auth | Descripcion |
|--------|------|------|-------------|
| POST | /api/whatsapp/send | Bearer admin | Enviar mensaje (texto o template) |
| GET | /api/whatsapp/conversations | Bearer admin | Conversaciones agrupadas por teléfono (incluye números sin cliente) |
| GET | /api/whatsapp/messages/:phone | Bearer admin | Historial de mensajes por teléfono |
| POST | /communications/webhook | Firma Twilio | Webhook para recibir mensajes de Twilio |

**POST /api/whatsapp/send** (requiere `Authorization: Bearer {accessToken}`)
```typescript
// Request (mensaje de texto libre - solo dentro de ventana de 24h)
{ to: string; body: string }

// Request (template aprobado - fuera de ventana de 24h)
{ 
  to: string; 
  templateName: string;
  variables?: Record<string, string> // Variables posicionales: {"1": "valor", "2": "valor"}
}

// Response 201
{
  success: boolean;
  messageSid: string;
  message: string;
}
// Error 401: UNAUTHORIZED
```

**GET /api/whatsapp/conversations** (requiere `Authorization: Bearer {accessToken}`)
```typescript
// Response 200
{
  conversations: {
    phone: string;
    clientId?: string;   // undefined si el número no pertenece a un cliente registrado
    profileName?: string; // nombre que Twilio reportó del remitente
    lastMessage: WhatsAppMessage;
    messageCount: number;
  }[];
  total: number;
}
// Error 401: UNAUTHORIZED
```

**GET /api/whatsapp/messages/:phone** (requiere `Authorization: Bearer {accessToken}`)
```typescript
// Response 200
{
  messages: WhatsAppMessage[];
  total: number;
}
// Error 401: UNAUTHORIZED
```

**POST /communications/webhook** (interno - Twilio)
```typescript
// Webhook configurado en Twilio Console
// No usa JWT de admin
// Valida firma X-Twilio-Signature (obligatoria en NODE_ENV=production)
// En development se puede desactivar con TWILIO_WEBHOOK_VALIDATION=false
// Guarda mensajes entrantes en Firestore
// Error 403: INVALID_WEBHOOK
```
---

## Casos de Uso

### 1. Crear suscripcion nueva (cliente nuevo)

```
POST /subscriptions
{ clientId, planId, kitNumber, billingDay: 5, maxOverduePeriods: 2 }
```
- Crea suscripcion `ACTIVE` + 1 periodo actual `PENDING` (segun fecha de corte)
- No se generan periodos anteriores a la fecha de registro
- El pago del periodo inicial se registra despues con `POST /billing-periods/:id/pay`

### 2. Crear suscripcion retroactiva (cliente antiguo, sin comprobantes)

```
POST /subscriptions
{ clientId, planId, kitNumber, billingDay: 6, maxOverduePeriods: 2, activationDate: "2026-01-05" }
```
- Genera periodos desde activationDate hasta hoy
- El primer mes de activacion siempre nace `PENDING` (el cliente pago para activar, aunque el pago no este registrado aun)
- Periodos siguientes pasados → `OVERDUE`, periodo actual → `PENDING` (maximo `maxOverduePeriods` vencidos)
- Si overdueCount >= maxOverduePeriods → suscripcion `SUSPENDED` y NO se genera el periodo actual (los meses durante la suspension no generan deuda)
- El primer mes de activacion nunca pasa a `OVERDUE`, ni siquiera por el Daily Job
- Al pagar todos los vencidos, la suscripcion se reactiva y se genera el periodo actual desde hoy + billingDay
- Frontend muestra periodos vencidos con boton "Registrar Pago"

### 3. Crear suscripcion retroactiva (cliente antiguo, con comprobantes)

```
POST /subscriptions
{
  clientId, planId, kitNumber, billingDay: 6, maxOverduePeriods: 3,
  activationDate: "2026-01-05",
  historicalPayments: [
    { periodLabel: "Enero - Febrero", startDate: "2026-01-05", endDate: "2026-02-06", amount: 50, paidAt: "2026-02-04", paymentMethod: "CASH" },
    { periodLabel: "Febrero - Marzo", startDate: "2026-02-06", endDate: "2026-03-06", amount: 50, paidAt: "2026-03-03", paymentMethod: "TRANSFER" }
  ]
}
```
- Genera periodos, marca como `PAID` los que coinciden con pagos historicos
- El primer mes de activacion sin pago historico queda `PENDING` (regla de activacion)
- Resto: `OVERDUE` o `PENDING` segun fecha
- amount debe ser igual al precio del plan

### 4. Registrar pago en periodo pendiente/vencido

```
POST /billing-periods/:id/pay
{ paymentMethod: "CASH", amount: 50, paidAt: "2026-07-31" }
```
- amount debe coincidir con el amount del periodo
- La reactivacion requiere pagar TODOS los periodos vencidos (overdueCount === 0)
- Si la suscripcion estaba `SUSPENDED` y se reactiva → `reactivated: true`
- Al reactivar se genera el periodo actual `PENDING` desde hoy + billingDay (respuesta: `currentPeriod`)

### 5. Editar datos de pago de periodo ya pagado

```
PUT /billing-periods/:id
{ paymentMethod: "TRANSFER", paidAt: "2026-07-15" }
```
- Solo funciona en periodos `PAID`
- Actualizacion parcial (solo campos enviados)
- Caso principal: corregir datos de pago de periodos existentes (incluye periodos antiguos con `INITIAL_PAYMENT`)

### 6. Registrar el pago de un período pendiente o vencido

```
POST /billing-periods/:id/pay
{ paymentMethod: "CASH", amount: 50, paidAt: "2026-07-31" }
```
- El período pasa de `PENDING`/`OVERDUE` a `PAID`
- Si era el último vencido de una suscripcion `SUSPENDED`, se reactiva y se genera el período actual `PENDING`
- Ver Caso de Uso 4

### 7. Enviar mensaje de WhatsApp desde perfil de cliente

> Requiere header `Authorization: Bearer {accessToken}` en send e historial.

**Opción A: Mensaje libre (solo si cliente escribió en últimas 24h)**
```
POST /api/whatsapp/send
Authorization: Bearer {accessToken}
{ to: "+584123456789", body: "Hola, tu pago fue recibido correctamente" }
```
- Solo funciona si el cliente inició la conversación en las últimas 24 horas
- Si falla, usar template

**Opción B: Template aprobado (siempre funciona)**
```
POST /api/whatsapp/send
Authorization: Bearer {accessToken}
{ 
  to: "+584123456789",
  templateName: "subscription_reminder_3days_2v_hxfcc8ae438db9df662a0e1f7d801e946b",
  variables: { "1": "Juan Pérez", "2": "2026-02-29" }
}
```
- Funciona en cualquier momento
- Usar cuando el cliente no ha escrito recientemente

**Ver historial de conversación:**
```
GET /api/whatsapp/messages/+584123456789
Authorization: Bearer {accessToken}
```
- Mostrar en perfil del cliente
- Ordenado por fecha (más reciente primero)
- Diferenciar visualmente mensajes entrantes vs salientes
### 8. Templates de WhatsApp disponibles

**Template 1: Recordatorio de pago (3 días antes)**
- **Nombre:** `subscription_reminder_3days_2v_hxfcc8ae438db9df662a0e1f7d801e946b`
- **Variables:**
  - `{1}` = Nombre del cliente (string)
  - `{2}` = Fecha de vencimiento (YYYY-MM-DD)
- **Uso:** Enviar 3 días antes del vencimiento del período

**Template 2: Advertencia de suspensión**
- **Nombre:** `subscription_suspension_warning_1day_2v_hxfcc8ae438db9df662a0e1f7d801e946b`
- **Variables:**
  - `{1}` = Nombre del cliente (string)
  - `{2}` = Número de KIT (string)
  - `{3}` = Fecha de vencimiento (YYYY-MM-DD)
- **Uso:** Enviar cuando la suscripción está por vencer o vencida

**Nota:** El scheduler envía estos templates automáticamente. El frontend solo necesita mostrar el historial.

---

## Reglas Rapidas

| Regla | Detalle |
|-------|---------|
| billingDay | 1-28 |
| kitNumber | Se convierte a UPPERCASE automaticamente |
| accountNumber | Formato libre (ej: "ACC-8381534-78084-24") |
| activationDate | Formato YYYY-MM-DD, no futura |
| paidAt | Formato YYYY-MM-DD (solo fecha, sin hora) |
| historicalPayments | Requiere activationDate |
| amount (pagos historicos) | Igual al precio del plan |
| paymentMethod (pagos historicos) | No INITIAL_PAYMENT |
| POST /pay (amount) | Debe coincidir con amount del periodo |
| PUT /billing-periods/:id | Solo periodos PAID |
| DELETE /subscriptions/:id | Elimina suscripcion y sus periodos de facturacion |
| cronSchedule | Expresion cron valida (ej: "0 0 * * *" = medianoche diario) |
| scheduler enabled | Si es false, el Daily Job no se ejecuta automaticamente |
| POST /scheduler/run | Ejecuta el job manualmente sin importar enabled |
| dni | Opcional; SOLO "V-" o "J-" + 7-9 digitos numericos con guion (ej: V-2769383); unico |
| PUT /clients/:id dni | null o "" elimina la cedula |
| Suscripcion SUSPENDED | overdueCount >= maxOverduePeriods |
| Suscripcion reactivada | overdueCount === 0 al pagar (todos los vencidos) |
| Periodo actual al reactivar | Se genera desde hoy + billingDay como PENDING |

---

## Formato de Error

```typescript
{ error: { code: string; message: string } }
```

Codigos principales: `NOT_FOUND` | `INVALID_DATA` | `INVALID_DNI` | `DNI_TAKEN` | `INVALID_PERIOD_STATE` | `PERIOD_ALREADY_PAID` | `INVALID_PAYMENT_AMOUNT` | `CLIENT_HAS_ACTIVE_SUBSCRIPTIONS` | `PLAN_HAS_SUBSCRIPTIONS` | `CANNOT_DELETE_SELF` | `LAST_ADMIN`
