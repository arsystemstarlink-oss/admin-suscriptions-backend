Documento de Diseño - Sistema de Gestión de Suscripciones

> **Anexo Multi-Tenant (2026):** el sistema soporta múltiples organizaciones aisladas.
> Ver sección "13. Multi-Tenant por Organización" al final.

1. Objetivo del sistema

El sistema tiene como objetivo administrar clientes con servicios de suscripción, permitiendo:

Registrar clientes.
Administrar suscripciones asociadas.
Controlar períodos de servicio.
Registrar el estado de pago de cada período.
Consultar rápidamente historial de servicio.
Automatizar generación de nuevos períodos.
Controlar suspensión y reactivación de servicios.

El sistema no es un sistema contable ni de pagos.

No administra:

Bancos.
Facturas fiscales.
Conciliaciones.
Métodos complejos de pago.
Pagos parciales.

Su función principal es responder:

¿Qué cliente tiene qué servicio y cuál es su situación actual?

2. Modelo de entidades
User

Representa al usuario administrador del sistema.

Responsabilidades:

Acceder al dashboard.
Administrar clientes.
Crear suscripciones.
Registrar pagos de períodos.

Campos:

User {
 id: string
 name: string
 email: string
 role: "admin"
 createdAt: Date
}
Client

Representa al cliente que contrata el servicio.

Reglas:

Puede existir sin suscripciones.
Puede tener una o varias suscripciones.

Campos:

Client {

 id: string

 name: string

 phone: string

 email?: string

 address?: string

 notes?: string

 createdAt: Date
}

Relación:

Client
 |
 |-- Subscription
 |-- Subscription
Plan

Representa un producto comercial.

No tiene historial.

No pertenece a clientes.

Campos:

Plan {

 id:string

 name:string

 price:number

 description:string

 active:boolean

}

Ejemplos:

Residencial
35$

Itinerante
50$

Pausado
10$
Subscription

Representa el servicio contratado por un cliente.

Es la entidad principal del sistema.

Campos:

Subscription {

id:string

clientId:string

planId:string


kitNumber:string

billingDay:number


status:
 "ACTIVE"
 "SUSPENDED"


createdAt:Date

}
Estados de Subscription
ACTIVE

Servicio operativo.

Puede tener períodos:

Pagados.
Pendientes.
Vencidos.
SUSPENDED

Servicio suspendido.

Reglas:

No genera nuevos períodos.
Mantiene deuda pendiente.
Puede volver a ACTIVE.

Proceso:

Suspended

↓

Cliente paga deuda completa

↓

Active
3. Billing Period

Representa un ciclo de servicio.

No representa una factura.

No representa contabilidad.

Representa:

El período de tiempo que el cliente tiene derecho al servicio.

Campos:

BillingPeriod {

id:string

subscriptionId:string


periodLabel:string

"Julio - Agosto"


startDate:Date

endDate:Date


amount:number


status:

"PENDING"

"PAID"

"OVERDUE"


paidAt?:Date


paymentMethod?:string


notes?:string

}
Estados del Billing Period
Pending

El período está vigente y todavía no ha sido pagado.

Ejemplo:

5 Agosto
-
5 Septiembre

Pending
Paid

El cliente pagó ese período.

Información adicional:

paidAt

paymentMethod

amount

Ejemplo:

Pagado:

20 Agosto

Método:

USDT
Overdue

El período terminó y no fue pagado.

Ejemplo:

5 Julio
-
5 Agosto

Overdue
4. Reglas del negocio
Creación de cliente

Permitido sin suscripción.

Creación de suscripción

Cuando se crea:

Siempre:

Subscription.status = ACTIVE

y

Primer BillingPeriod = PENDING

Porque el período se registra pendiente de pago; el pago se confirma después.

Ejemplo:

Registro:

20 Julio

Fecha corte:

5

Sistema calcula:

5 Julio
-
5 Agosto

Crea:

BillingPeriod

Julio-Agosto

PENDING
5. Fecha de corte

La fecha de corte determina los períodos.

No depende de la fecha de registro.

Ejemplo:

Cliente registrado:

20 Julio

Corte:

5

Período:

5 Julio
-
5 Agosto
6. Generación automática de períodos

Los períodos no son creados manualmente.

Un proceso automático revisa diariamente.
Reglas:

Si el período actual finalizó (PAID u OVERDUE)

Cuando llega su fecha final:

Julio-Agosto

PAID

↓

Crear

Agosto-Septiembre

PENDING

Si el período actual finalizó sin pagar:

Julio-Agosto

OVERDUE

↓

Crear

Agosto-Septiembre

PENDING

(Se permite acumular deuda hasta el límite de la política del servicio.)

Si el período no está pagado

Cuando vence:

PENDING

↓

OVERDUE

Se permite acumular deuda según política del servicio.

Ejemplo:

Starlink:

Máximo períodos vencidos:

2
7. Política de suspensión

Cada servicio puede definir límite de deuda.

Ejemplo:

Subscription {

maxOverduePeriods:2

}

Proceso:

Overdue >= limite

↓

Suspended

Ejemplo:

Junio-Julio

Overdue


Julio-Agosto

Overdue


=

Suspended

Durante la suspensión:

No se generan períodos vencidos nuevos.

Los meses que transcurren suspendida no generan deuda.

No existe período actual mientras está suspendida.

Al pagar TODOS los períodos vencidos:

Suspended
→
Active

Se genera el período actual desde hoy + fecha de corte como PENDING.

8. Cambio de plan

Permitido.

Pero:

El cambio aplica al siguiente período.

Nunca modifica historial.

Ejemplo:

Julio-Agosto

Plan Residencial

35$

(Permanece)


Agosto-Septiembre

Plan Nuevo

50$
9. Registro de pago

No crea una entidad Payment.

El pago pertenece al BillingPeriod.

Solo guarda información mínima:

Fecha de pago.
Monto.
Método.
Nota.

Ejemplo:

BillingPeriod

Julio-Agosto


Estado:

PAID


Pago:

Fecha:
20 Julio


Monto:
35$


Método:
USDT
10. Automatizaciones necesarias
Daily Job

Responsable de:

Revisar períodos vencidos.
Crear nuevos períodos.
Suspender servicios.
Reactivar servicios cuando corresponda (la reactivación se dispara al registrar el pago que salda toda la deuda).
11. Colecciones Firebase propuestas
users

clients

plans

subscriptions

billingPeriods

Mantener pocas colecciones.

12. Filosofía del sistema

El administrador no debe tomar decisiones innecesarias.

El sistema debe calcular:

Qué período corresponde.
Cuándo crear uno nuevo.
Cuándo marcar vencido.
Cuándo suspender.
Cuándo reactivar.

El administrador solamente:

Registra clientes.
Crea servicios.
Cambia planes.
Confirma pagos.
13. Multi-Tenant por Organización

El sistema es multi-tenant: cada organización (tenant) tiene sus propios clientes, planes, suscripciones, períodos, mensajes y suscripciones push. Un admin solo opera sobre su organización; un super-admin opera globalmente.

AuthContext

Todo request autenticado resuelve:

AuthContext {
  userId: string;
  role: 'super-admin' | 'admin';
  organizationId: string | null; // null solo para super-admin
}

El backend ignora el organizationId que envíe el frontend para un admin y usa el de su contexto autenticado (JWT + verificación en Firestore). Esto impide acceso cruzado entre tenants (IDOR).

Entidades

- Organization: id, name, slug, active, createdAt, createdBy.
- User: agrega role ('super-admin' | 'admin') y organizationId (null para super-admin).
- Client, Plan, Subscription, BillingPeriod, PushSubscription: agregan organizationId obligatorio.
- WhatsAppMessage: organizationId opcional (los mensajes inbound de números sin cliente no tienen org).
- BillingPeriod conserva organizationId desnormalizado para filtros directos sin joins.
- domainEvents: colección de auditoría con organizationId, type, entity, entityId, payload.
- Payment: sigue siendo un value object embebido en BillingPeriod (paidAt, paymentMethod, amount, notes).

Alcance por rol

| Operación | admin | super-admin |
|-----------|-------|-------------|
| CRUD clientes/planes/suscripciones/períodos | Solo su org | Todas o `?organizationId=org_X` |
| POST /subscriptions | Valida clientId y planId en su org (CROSS_TENANT_REFERENCE si no) | Idem contra la org indicada |
| Dashboard | Solo su org | Todas o filtradas |
| Scheduler | Su org | `?organizationId` o global |
| Admins | Solo su org | Todos |
| Organizations | - | CRUD completo |

Daily Job

El cron global ejecuta runDailyJobForOrganization(orgId) por cada organización activa, escaneando solo sus datos y enviando notificaciones (WhatsApp/Push) dentro de la org. La configuración del scheduler es por organización (schedulerConfig/{orgId}) además de la global: el cron global respeta el `enabled` de cada org (si una org está desactivada, se omite). El run manual por org (`POST /scheduler/run`) ejecuta sin importar `enabled`.

Migración

npm run migrate:tenant crea organizations/org_default, asigna organizationId a todos los documentos existentes y valida que no queden huérfanos. Con --promote-super-admin promueve al primer admin a super-admin.