# Requisitos del Backend: Notificaciones Push (Web Push)

El frontend (PWA) ya implementa el lado del cliente: suscripción del navegador, service worker con
handlers `push` / `notificationclick`, página de activación en `Config → Notificaciones` y
endpoints de API esperados. Este documento ordena lo que el backend debe implementar.

---

## 1. Dependencia y configuración base

1. Instalar `web-push` (librería estándar de Node para Web Push).
2. Generar el par de llaves VAPID (una sola vez):

   ```bash
   npx web-push generate-vapid-keys --json
   ```

3. Configurar en variables de entorno del backend:

   | Variable            | Descripción                                   |
   | ------------------- | --------------------------------------------- |
   | `VAPID_PUBLIC_KEY`  | Llave pública VAPID (requerida)               |
   | `VAPID_PRIVATE_KEY` | Llave privada VAPID (requerida, nunca expuesta) |
   | `VAPID_SUBJECT`     | URL o `mailto:` de contacto (requerida)       |

4. Inicializar una única vez al arrancar la app:

   ```ts
   webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
   ```

---

## 2. Modelo de datos

Tabla `push_subscriptions` (una fila por dispositivo/navegador suscrito):

| Columna      | Tipo                        | Notas                                         |
| ------------ | --------------------------- | --------------------------------------------- |
| `id`         | UUID (PK)                   |                                               |
| `admin_id`   | UUID (FK → admins, índice)  | Propietario de la suscripción                 |
| `endpoint`   | TEXT (UNIQUE)               | URL de suscripción del navegador (única global) |
| `p256dh`     | TEXT                        | Clave de cifrado de la suscripción            |
| `auth`       | TEXT                        | Secreto de autenticación                      |
| `user_agent` | TEXT                        | Opcional, informativo                         |
| `created_at` | TIMESTAMP                   |                                               |
| `updated_at` | TIMESTAMP                   |                                               |

Regla de negocio: el `endpoint` es único en toda la tabla. Si el mismo navegador se suscribe con
otro administrador, la suscripción se **re-asigna** al nuevo admin (upsert por `endpoint`).

---

## 3. Endpoints (todos bajo `/api/push`, auth JWT excepto el primero)

### 3.1 `GET /push/vapid-public-key` — público, sin auth

Devuelve la llave pública VAPID para que el navegador cree la suscripción. El frontend la usa
cuando `VITE_VAPID_PUBLIC_KEY` no está definido.

**200 OK**
```json
{ "vapidPublicKey": "BEl..._pública..." }
```

**503** si VAPID no está configurado (el frontend muestra el error `VAPID_NOT_CONFIGURED`).

### 3.2 `POST /push/subscriptions` — auth (admin)

Registra (o actualiza, upsert por `endpoint`) la suscripción del admin autenticado.

**Body** (exactamente el JSON de `PushSubscription.toJSON()` del navegador + `userAgent`):
```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/abc123...",
  "expirationTime": null,
  "keys": {
    "p256dh": "BBxE...",
    "auth": "9x8f..."
  },
  "userAgent": "Mozilla/5.0 ..."
}
```

**201 Created**
```json
{ "subscription": { "id": "uuid", "endpoint": "https://...", "userAgent": "Mozilla/5.0 ...", "createdAt": "2026-08-17T18:00:00.000Z" } }
```

**400** si faltan `endpoint`, `keys.p256dh` o `keys.auth` → `INVALID_PAYLOAD`.

### 3.3 `GET /push/subscriptions` — auth (admin)

Lista las suscripciones activas del admin autenticado (el frontend la usa para saber si el
dispositivo ya está registrado).

**200 OK**
```json
{
  "subscriptions": [
    { "id": "uuid", "endpoint": "https://...", "userAgent": "Mozilla/5.0 ...", "createdAt": "2026-08-17T18:00:00.000Z" }
  ]
}
```

### 3.4 `DELETE /push/subscriptions/:endpoint` — auth (admin)

Elimina la suscripción del admin autenticado cuyo `endpoint` (URL-encoded) coincida.

**200 OK**
```json
{ "message": "Suscripción eliminada" }
```

**404** si no existe → `PUSH_SUBSCRIPTION_NOT_FOUND`.

### 3.5 `POST /push/test` — auth (admin)

Envía una notificación de prueba a **todas** las suscripciones del admin autenticado. Útil para
verificar el flujo desde la página de Notificaciones.

**200 OK**
```json
{ "message": "Notificación enviada", "sent": 1 }
```

**503** si VAPID no está configurado → `VAPID_NOT_CONFIGURED`.

### 3.6 `POST /push/send` — auth (admin)

Envía una notificación a los administradores (uso interno: tarea diaria, vencimientos, mensajes
entrantes).

**Body**
```json
{
  "adminIds": ["uuid1", "uuid2"],
  "title": "Suscripción por vencer",
  "body": "El kit #123 vence el 20/08",
  "data": { "url": "/subscriptions/abc123" }
}
```

- Si `adminIds` se omite → se envía a **todos** los administradores con suscripciones activas.
- `data.url` es relativa a la raíz de la app y se usa al hacer clic en la notificación.

**200 OK**
```json
{ "message": "Notificación enviada", "sent": 3 }
```

**503** si VAPID no está configurado → `VAPID_NOT_CONFIGURED`.

---

## 4. Formato del payload push

El backend envía JSON al navegador. El service worker del frontend acepta dos formas:

1. **Plana** (recomendada para este proyecto):
   ```json
   {
     "title": "Título",
     "body": "Texto",
     "icon": "pwa-192.png",
     "badge": "pwa-192.png",
     "data": { "url": "/dashboard" }
   }
   ```

2. **Envoltorio `notification`** (compatible con convenciones de la web):
   ```json
   { "notification": { "title": "Título", "body": "Texto", "data": { "url": "/dashboard" } } }
   ```

`icon` / `badge` opcionales; el SW usa `pwa-192.png` por defecto. Opciones de envío:
`webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 60 * 60 })`.

---

## 5. Manejo de errores de envío (web-push)

| Código HTTP | Significado                     | Acción                                         |
| ----------- | ------------------------------- | ---------------------------------------------- |
| `404`       | Suscripción no existe           | Eliminar la fila de `push_subscriptions`       |
| `410`       | Suscripción expirada/eliminada  | Eliminar la fila de `push_subscriptions`       |
| `403`       | Sin permisos                    | Registrar en logs; no reintentar               |
| `413`       | Payload demasiado grande        | Reducir payload                                |
| `429`       | Rate limit                      | Reintentar con backoff exponencial             |

---

## 6. Códigos de error de negocio (formato `{ error: { code, message } }`)

- `VAPID_NOT_CONFIGURED` (503) — llaves VAPID ausentes en el entorno.
- `PUSH_SUBSCRIPTION_NOT_FOUND` (404) — endpoint no registrado.
- `INVALID_PAYLOAD` (400) — body incompleto al registrar.

Los códigos `VAPID_NOT_CONFIGURED` y `PUSH_SUBSCRIPTION_NOT_FOUND` ya están mapeados en el
frontend (`src/lib/error-handler.ts`).

---

## 7. Integración con el sistema existente

1. **Tarea diaria / scheduler** (`POST /push/send`): al ejecutar la evaluación de vencimientos,
   enviar push a los admins con el resumen (vencimientos próximos, períodos vencidos,
   suscripciones suspendidas).
2. **Mensajes entrantes (WhatsApp)**: cuando llega un mensaje de un cliente, notificar a los
   admins con `data.url = "/chats"` (o el teléfono del cliente si se define la ruta).
3. **Pagos registrados**: opcional, avisar cuando un período se marca como pagado.

---

## 8. Consideraciones de plataforma

- **iOS (16.4+)**: el push solo funciona con la app instalada en la pantalla de inicio. No es un
  problema del backend; el frontend ya muestra ese aviso.
- **HTTPS obligatorio**: Web Push requiere HTTPS (en localhost funciona sin certificado).
- **Suscripciones huérfanas**: al eliminar un admin, borrar sus `push_subscriptions` en cascada.
- **Seguridad**: `POST /push/send` debe verificar que `adminIds` contenga admins válidos; la
  suscripción siempre se registra contra el admin del JWT (nunca confiar en un `adminId` del body
  para el registro).
