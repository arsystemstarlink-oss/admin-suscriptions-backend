# Plan de desarrollo del backend - ✅ COMPLETADO

## Objetivo

Construir un backend limpio y sólido para el sistema de gestión de suscripciones, con reglas consistentes, entidades bien definidas y una automatización confiable de períodos de facturación.

**Estado**: ✅ Todas las fases completadas

## Fase 1: Diseño de dominio y modelo de datos

### Objetivos
- Definir las entidades principales y sus atributos.
- Establecer las reglas de negocio e invariantes.
- Seleccionar la estructura de almacenamiento.

### Entidades
- `users`
  - id: string
  - name: string
  - email: string
  - role: "admin"
  - createdAt: Date

- `clients`
  - id: string
  - name: string
  - phone: string
  - email?: string
  - address?: string
  - notes?: string
  - createdAt: Date

- `plans`
  - id: string
  - name: string
  - price: number
  - description: string
  - active: boolean
  - createdAt: Date

- `subscriptions`
  - id: string
  - clientId: string
  - planId: string
  - kitNumber: string
  - billingDay: number
  - status: "ACTIVE" | "SUSPENDED"
  - maxOverduePeriods: number
  - createdAt: Date

- `billingPeriods`
  - id: string
  - subscriptionId: string
  - periodLabel: string
  - startDate: Date
  - endDate: Date
  - amount: number
  - status: "PENDING" | "PAID" | "OVERDUE"
  - paidAt?: Date
  - paymentMethod?: string
  - notes?: string
  - createdAt: Date

### Reglas de diseño
- El primer `BillingPeriod` de cada suscripción se crea al registrar la suscripción y comienza como `PAID`.
- `Subscription.status` controla si se generan períodos automáticos.
- No habrá una entidad `Payment`; la información de pago se almacena en `BillingPeriod`.
- Las colecciones principales serán: `users`, `clients`, `plans`, `subscriptions`, `billingPeriods`.

## Fase 2: API básica y validaciones

### Objetivos
- Implementar operaciones CRUD para los recursos clave.
- Añadir validaciones estrictas para datos y estados.
- Evitar inconsistencias en puntos críticos.

### Endpoints mínimos
- `clients`: crear, obtener, actualizar, listar.
- `plans`: crear, obtener, actualizar, listar.
- `subscriptions`: crear, obtener, actualizar, listar.
- `billingPeriods`: obtener, actualizar estado de pago.

### Validaciones clave
- `billingDay` debe ser un número entre 1 y 28.
- `subscription.status` debe ser `ACTIVE` o `SUSPENDED`.
- `billingPeriod.status` debe ser `PENDING`, `PAID`, `OVERDUE`.
- `plan.active` debe definirse como booleano.
- Al crear una suscripción, forzar `status = ACTIVE` y crear el primer período `PAID`.
- No permitir la creación de períodos manuales.

## Fase 3: Lógica de períodos y automatización ✅ COMPLETADA

### Objetivos
- Calcular períodos naturales a partir de la fecha de corte. ✅
- Automatizar la evolución del ciclo de facturación. ✅
- Garantizar estados coherentes de los períodos. ✅

### Reglas de período
- La fecha de corte determina `startDate` y `endDate`. ✅
- El primer período se calcula a partir de la fecha de registro y el `billingDay`. ✅
- Un período `PAID` que vence debe generar el siguiente período `PENDING`. ✅
- Un período `PENDING` que vence se marca `OVERDUE`. ✅

### Automatización diaria ✅ IMPLEMENTADA
- Revisar todos los `billingPeriods` actuales. ✅
- Marcar como `OVERDUE` los períodos `PENDING` vencidos. ✅
- Crear el siguiente `billingPeriod` `PENDING` cuando un `PAID` llegue a su fecha final. ✅
- Evaluar deuda acumulada y suspender suscripciones según `maxOverduePeriods`. ✅

**Implementación**: Scheduler con node-cron en `src/infrastructure/scheduler.ts`
- Ejecución automática según configuración `CRON_SCHEDULE` en `.env`

## Fase 4: Pagos y reactivación

### Objetivos
- Registrar pagos de forma segura y coherente.
- Reactivar servicios cuando se normalice la deuda.
- Mantener la lógica de negocio centralizada.

### Reglas de pago
- El pago de un `billingPeriod` actualiza:
  - `status = PAID`
  - `paidAt`
  - `paymentMethod`
  - `amount`
  - `notes`
- Solo un pago completo puede cambiar un período a `PAID`.

### Reactivación
- Si una `Subscription` `SUSPENDED` paga su deuda total y queda dentro del límite, debe pasar a `ACTIVE`.
- El siguiente período debe generarse según la lógica de corte y estado de suscripción.

## Fase 5: Seguridad y consistencia ✅ COMPLETADA

### Objetivos
- Proteger el backend contra estados inválidos. ✅
- Usar transacciones o mecanismos similares para cambios multi-entidad. ✅
- Documentar y probar las reglas de negocio. ✅

### Controles ✅ IMPLEMENTADOS
- Acceso restringido a `admin`. ✅
  - Middleware de autenticación con API Key
  - Header: `x-api-key` o query parameter `apiKey`
  - Configurado en `src/api/middleware/auth.ts`
- Uso de transacciones en: ✅
  - Creación de suscripción + primer período (atómico en memoria)
  - Actualización de pago + cambio de estado de suscripción (atómico en memoria)
- Validaciones antes de persistir cambios. ✅

### Pruebas ✅ IMPLEMENTADAS
- Test de creación de cliente/plan/suscripción. ✅
- Test de cálculo de períodos. ✅
- Test de paso `PENDING` → `OVERDUE`. ✅
- Test de suspensión por `maxOverduePeriods`. ✅
- Test de reactivación por pago completo. ✅
- Test de cambio de plan que solo afecta al siguiente período. ✅

**Implementación**: Jest + ts-jest en `src/__tests__/subscription-service.test.ts`
- 15+ tests unitarios cubriendo todas las reglas de negocio
- Ejecutar con: `npm test`

## Fase 6: Documentación y despliegue ✅ COMPLETADA

### Objetivos
- Entregar un backend fácil de entender y mantener. ✅
- Documentar flujos, modelos y automatizaciones. ✅
- Preparar el despliegue en el entorno seleccionado. ✅

### Entregables ✅ COMPLETADOS
- Documentación de API con ejemplos. ✅
  - Archivo: `API-DOCS.md`
  - Ejemplos completos de todos los endpoints
  - Flujo de uso paso a paso
- Descripción de entidades y reglas. ✅
  - Archivo: `document-proyect.md`
  - Modelo de entidades completo
  - Reglas de negocio documentadas
- Documentación del cron diario y su lógica. ✅
  - Archivo: `API-DOCS.md` (sección "Daily Job Automático")
  - Archivo: `DEPLOYMENT.md` (sección de configuración)
- Checklist de despliegue con variables de entorno. ✅
  - Archivo: `DEPLOYMENT.md`
  - Variables de entorno en `.env.example`
  - Instrucciones de instalación y ejecución

## Recomendaciones para evitar errores

- Mantener la lógica de negocio en un único servicio de dominio.
- No delegar cálculos de períodos al frontend.
- Evitar actualizaciones manuales de estados críticos sin verificar reglas.
- Revisar y probar cada regla de negocio documentada.
- Manejar casos límite como clientes sin suscripciones, corte en días altos, y acumulación de deuda.
