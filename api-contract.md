# API Contract

## Configuracion

```
Base URL: http://localhost:3000/api
Auth: Authorization: Bearer {accessToken}
```

**Tokens:** accessToken (15 min) | refreshToken (7 dias)

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
// INITIAL_PAYMENT es interno, no usar en el frontend

enum SubscriptionStatus { ACTIVE, SUSPENDED }

enum BillingPeriodStatus { PENDING, PAID, OVERDUE }
```

### Entidades

```typescript
interface Client {
  id: string; name: string; phone: string;
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
  client: Pick<Client, 'id' | 'name' | 'phone' | 'email'>;
  plan: Pick<Plan, 'id' | 'name' | 'price'>;
  currentPeriod?: BillingPeriod;
  totalPeriods: number; overduePeriods: number;
  pendingPeriods: number; hasDebt: boolean;
}

interface BillingPeriodWithDetails extends BillingPeriod {
  subscription: Pick<Subscription, 'id' | 'kitNumber' | 'status'>;
  client: Pick<Client, 'id' | 'name' | 'phone' | 'email'>;
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
}

interface DebtorItem {
  clientId: string; clientName: string; clientPhone: string;
  totalDebt: number; overdueCount: number;
}
```

---

## Endpoints

### Auth

| Metodo | Path | Descripcion |
|--------|------|-------------|
| POST | /auth/login | Login |
| POST | /auth/refresh | Renovar tokens |

**POST /auth/login**
```typescript
// Request
{ email: string; password: string }
// Response 200
{ accessToken: string; refreshToken: string; user: User }
```

**POST /auth/refresh**
```typescript
// Request
{ refreshToken: string }
// Response 200
{ accessToken: string; refreshToken: string }
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
{ name: string; phone: string; email?: string; address?: string; notes?: string }
// Response 201 → Client
```

**PUT /clients/:id**
```typescript
// Request (partial)
{ name?: string; phone?: string; email?: string; address?: string; notes?: string }
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
| POST | /billing-periods/generate-next/:subscriptionId | Generar siguiente periodo |
| POST | /billing-periods/evaluate-overdue | Evaluar vencimientos |

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

**POST /billing-periods/generate-next/:subscriptionId** → Response 201 → `BillingPeriod`

**POST /billing-periods/evaluate-overdue**
```typescript
// Response 200
{ message: string; evaluatedAt: string }
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

| Metodo | Path | Descripcion |
|--------|------|-------------|
| POST | /api/whatsapp/send | Enviar mensaje (texto o template) |
| GET | /api/whatsapp/messages/:phone | Historial de mensajes por teléfono |
| POST | /communications/webhook | Webhook para recibir mensajes de Twilio |

**POST /api/whatsapp/send**
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
```

**GET /api/whatsapp/messages/:phone**
```typescript
// Response 200
{
  messages: WhatsAppMessage[];
  total: number;
}
```

**POST /communications/webhook** (interno - Twilio)
```typescript
// Webhook configurado en Twilio Console
// No requiere autenticación (Twilio firma las requests)
// Guarda mensajes entrantes en Firestore
```

---

## Casos de Uso

### 1. Crear suscripcion nueva (cliente nuevo, paga hoy)

```
POST /subscriptions
{ clientId, planId, kitNumber, billingDay: 5, maxOverduePeriods: 2 }
```
- Crea suscripcion `ACTIVE` + 1 periodo `PAID` con `paymentMethod: INITIAL_PAYMENT`
- Frontend detecta `INITIAL_PAYMENT` → mostrar badge "Datos pendientes"
- Editar con `PUT /billing-periods/:id` para poner datos reales del pago

### 2. Crear suscripcion retroactiva (cliente antiguo, sin comprobantes)

```
POST /subscriptions
{ clientId, planId, kitNumber, billingDay: 6, maxOverduePeriods: 2, activationDate: "2026-01-05" }
```
- Genera periodos desde activationDate hasta hoy
- Periodos pasados → `OVERDUE`, periodo actual → `PENDING`
- Si overdueCount >= maxOverduePeriods → suscripcion `SUSPENDED`
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
- Resto: `OVERDUE` o `PENDING` segun fecha
- amount debe ser igual al precio del plan

### 4. Registrar pago en periodo pendiente/vencido

```
POST /billing-periods/:id/pay
{ paymentMethod: "CASH", amount: 50, paidAt: "2026-07-31" }
```
- amount debe coincidir con el amount del periodo
- Si la suscripcion estaba `SUSPENDED` y se reactiva → `reactivated: true`

### 5. Editar datos de pago de periodo ya pagado

```
PUT /billing-periods/:id
{ paymentMethod: "TRANSFER", paidAt: "2026-07-15" }
```
- Solo funciona en periodos `PAID`
- Actualizacion parcial (solo campos enviados)
- Caso principal: editar primer periodo con `INITIAL_PAYMENT`

### 6. Identificar periodos con datos incompletos

```
GET /billing-periods?subscriptionId=xxx
// Filtrar donde paymentMethod === 'INITIAL_PAYMENT'
```
- Mostrar indicador visual "Datos pendientes"
- Editar con `PUT /billing-periods/:id`

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
| generate-next | Periodo actual debe estar PAID y finalizado |
| DELETE /subscriptions/:id | Elimina suscripcion y sus periodos de facturacion |
| cronSchedule | Expresion cron valida (ej: "0 0 * * *" = medianoche diario) |
| scheduler enabled | Si es false, el Daily Job no se ejecuta automaticamente |
| POST /scheduler/run | Ejecuta el job manualmente sin importar enabled |
| Suscripcion SUSPENDED | overdueCount >= maxOverduePeriods |
| Suscripcion reactivada | overdueCount < maxOverduePeriods al pagar |

---

## Formato de Error

```typescript
{ error: { code: string; message: string } }
```

Codigos principales: `NOT_FOUND` | `INVALID_DATA` | `INVALID_PERIOD_STATE` | `PERIOD_ALREADY_PAID` | `INVALID_PAYMENT_AMOUNT` | `CLIENT_HAS_ACTIVE_SUBSCRIPTIONS` | `PLAN_HAS_SUBSCRIPTIONS`
