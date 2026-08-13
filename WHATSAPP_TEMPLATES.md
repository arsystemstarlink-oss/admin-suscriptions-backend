# WhatsApp Templates - Documentacion

## Templates Disponibles

### 1. Recordatorio de Pago (3 dias antes del vencimiento)

**Nombre del Template:**
```
subscription_reminder_3days_2v_hxfcc8ae438db9df662a0e1f7d801e946b
```

**Variables:**
- `{1}` = Nombre del cliente (string)
- `{2}` = Fecha de vencimiento (formato: YYYY-MM-DD)

**Ejemplo de mensaje generado:**
```
Hola Adrianfer, te recordamos que tu suscripcion de Starlink vence el 2026-02-29. 📅

Para evitar la suspension del servicio, te recomendamos realizar el pago antes de la fecha indicada.

Si ya realizaste el pago, por favor ignora este mensaje.

A|R System
> Este es un mensaje automatico de notificacion, no es necesario responder.
```

**Cuando se envia:**
- Suscripcion `ACTIVE` + periodo `PENDING` o `PAID` + exactamente 3 dias antes del vencimiento
- Tipo de notificacion: `reminder`

---

### 2. Advertencia de Vencimiento (dia exacto del vencimiento)

**Nombre del Template:**
```
subscription_suspension_warning_1day_2v_hxfcc8ae438db9df662a0e1f7d801e946b
```

**Variables:**
- `{1}` = Nombre del cliente (string)
- `{2}` = Numero de KIT (string, ej: "KIT29JD9M291")
- `{3}` = Fecha de vencimiento (formato: YYYY-MM-DD)

**Ejemplo de mensaje generado:**
```
Hola Adrianfer, te informamos que tu suscripcion de Starlink KIT29JD9M291 vence hoy 2026-02-29. ⏰

Para evitar la suspension del servicio, te recomendamos realizar el pago antes de la hora de corte establecida.

Si ya realizaste el pago, por favor ignora este mensaje.

A|R System
> Este es un mensaje automatico de notificacion, no es necesario responder.
```

**Cuando se envia:**
- Suscripcion `ACTIVE` + periodo `PENDING` + dia exacto del vencimiento (0 dias)
- Tipo de notificacion: `suspension-warning`

---

### 3. Aviso de Suspension

**Nombre del Template:**
```
subscription_suspended_notice_2v_hx9954143348c57d5cfb1daf4b5ab8ee6b
```

**Variables:**
- `{1}` = Nombre del cliente (string)
- `{2}` = Numero de KIT (string, ej: "KIT28J720NS8")

**Ejemplo de mensaje generado:**
```
Hola Adrianfer, te informamos que tu suscripcion de Starlink KIT28J720NS8 fue suspendida por falta de pago. ⚠️

Para reactivar el servicio, te recomendamos realizar el pago pendiente o contactar a soporte para mayor informacion.

A|R System
> Este es un mensaje automatico de notificacion, no es necesario responder.
```

**Cuando se envia:**
- Cuando la suscripcion cambia de `ACTIVE` a `SUSPENDED`
- Tipo de notificacion: `suspended-notice`

---

## Resumen de Logica de Notificaciones

| Condicion | Tipo | Template | Variables |
|---|---|---|---|
| `ACTIVE` + `PENDING`/`PAID` + ≤7 días | — | Dashboard `expiringSoon` | `{1}` nombre, `{2}` fecha |
| `ACTIVE` + `PENDING`/`PAID` + 3 dias exactos | `reminder` | `PAYMENT_REMINDER` | `{1}` nombre, `{2}` fecha |
| `ACTIVE` + `PENDING`/`PAID` + 0 dias (hoy) | `suspension-warning` | `SUSPENSION_WARNING` | `{1}` nombre, `{2}` kit, `{3}` fecha |
| Cambio a `SUSPENDED` | `suspended-notice` | `REMINDER_TODAY` | `{1}` nombre, `{2}` kit |
| `SUSPENDED` (sin cambio) | — | Silencio | — |

---

## Uso en el Codigo

### Variables de Entorno

Configurar en `.env`:
```env
TWILIO_TEMPLATE_SUBSCRIPTION_REMINDER_3DAYS_2V=HX...
TWILIO_TEMPLATE_SUBSCRIPTION_CUTOFF_DAY_2V=HX...
TWILIO_TEMPLATE_SUBSCRIPTION_SUSPENDED_NOTICE_2V=HX...
```

### Enviar Template Manualmente

**Endpoint:** `POST /api/whatsapp/send`  
**Auth:** `Authorization: Bearer {accessToken}` (admin JWT obligatorio)

**Ejemplo de request (Recordatorio):**
```json
{
  "to": "+584123456789",
  "templateName": "subscription_reminder_3days_2v_hxfcc8ae438db9df662a0e1f7d801e946b",
  "variables": {
    "1": "Adrianfer",
    "2": "2026-02-29"
  }
}
```

**Ejemplo de request (Aviso de Suspension):**
```json
{
  "to": "+584123456789",
  "templateName": "subscription_suspended_notice_2v_hx9954143348c57d5cfb1daf4b5ab8ee6b",
  "variables": {
    "1": "Adrianfer",
    "2": "KIT28J720NS8"
  }
}
```

**Ejemplo de response:**
```json
{
  "success": true,
  "messageSid": "SM1234567890abcdef",
  "message": "Mensaje enviado correctamente."
}
```

### Envio Automatico (Scheduler)

El scheduler (`src/infrastructure/scheduler.ts`) envia automaticamente los templates:

```typescript
// Recordatorio (1-3 dias antes)
await sendWhatsAppNotification(client, subscription, currentPeriod, 'reminder');

// Advertencia de vencimiento (dia exacto)
await sendWhatsAppNotification(client, subscription, currentPeriod, 'suspension-warning');

// Aviso de suspension (cuando cambia a SUSPENDED)
await sendWhatsAppNotification(client, subscription, currentPeriod, 'suspended-notice');
```

---

## Reglas de WhatsApp/Twilio

### Ventana de 24 horas
- **Dentro de las 24 horas:** Puedes enviar mensajes libres si el usuario inicio la conversacion
- **Fuera de las 24 horas:** Solo puedes enviar mensajes usando **templates aprobados**

### Templates Aprobados
- Los templates deben ser aprobados por WhatsApp antes de usarlos
- Cada template tiene un `contentSid` unico
- Las variables son posicionales: `{1}`, `{2}`, `{3}`, etc.
- Las variables se pasan como un objeto JSON con claves string: `{"1": "valor", "2": "valor"}`

---

## Historial de Mensajes

Todos los mensajes (entrantes y salientes) se guardan en Firestore en la coleccion `whatsappMessages`.

**Ver historial de un cliente:**
```
GET /api/whatsapp/messages/:phone
Authorization: Bearer {accessToken}
```

**Webhook entrante (Twilio):**
```
POST /communications/webhook
```
- Público (sin JWT admin)
- Valida firma `X-Twilio-Signature` (obligatoria en production)
- Requiere `BASE_URL` coincidente con la URL configurada en Twilio Console
- En development se puede desactivar con `TWILIO_WEBHOOK_VALIDATION=false`

---

## Notas Importantes

- Los templates usan variables **posicionales**, no por nombre
- El formato de fecha debe ser `YYYY-MM-DD`
- El numero de telefono debe incluir el codigo de pais (ej: `+584123456789`)
- Todos los mensajes se guardan en Firestore para auditoria
- El scheduler se ejecuta diariamente segun el cron configurado en `CRON_SCHEDULE`
- `send` e historial requieren JWT de admin; solo el webhook de Twilio es público
