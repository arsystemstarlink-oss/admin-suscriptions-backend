# WhatsApp Templates - Documentación

## Templates Disponibles

### 1. Recordatorio de Pago (3 días antes del vencimiento)

**Nombre del Template:**
```
subscription_reminder_3days_2v_hxfcc8ae438db9df662a0e1f7d801e946b
```

**Variables:**
- `{1}` = Nombre del cliente (string)
- `{2}` = Fecha de vencimiento (formato: YYYY-MM-DD)

**Ejemplo de mensaje generado:**
```
Hola Adrianfer, te recordamos que tu suscripción de Starlink vence el 2026-02-29. 📅

Para evitar la suspensión del servicio, te recomendamos realizar el pago antes de la fecha indicada.

Si ya realizaste el pago, por favor ignora este mensaje.

A|R System
> Este es un mensaje automático de notificación, no es necesario responder.
```

**Cuándo se envía:**
- Automáticamente 3 días antes de la fecha de vencimiento del período de facturación
- Solo si el período está en estado `PENDING`

---

### 2. Advertencia de Suspensión

**Nombre del Template:**
```
subscription_suspension_warning_1day_2v_hxfcc8ae438db9df662a0e1f7d801e946b
```

**Variables:**
- `{1}` = Nombre del cliente (string)
- `{2}` = Número de KIT (string, ej: "KIT29JD9M291")
- `{3}` = Fecha de vencimiento (formato: YYYY-MM-DD)

**Ejemplo de mensaje generado:**
```
Hola Adrianfer, te informamos que tu suscripción de Starlink KIT29JD9M291 vence hoy 2026-02-29. ⏰

Para evitar la suspensión del servicio, te recomendamos realizar el pago antes de la hora de corte establecida.

Si ya realizaste el pago, por favor ignora este mensaje.

A|R System
> Este es un mensaje automático de notificación, no es necesario responder.
```

**Cuándo se envía:**
- Automáticamente cuando una suscripción cambia a estado `SUSPENDED`
- Se envía inmediatamente después de la suspensión

---

## Uso en el Código

### Variables de Entorno

Configurar en `.env`:
```env
TWILIO_TEMPLATE_PAYMENT_REMINDER=subscription_reminder_3days_2v_hxfcc8ae438db9df662a0e1f7d801e946b
TWILIO_TEMPLATE_SUSPENSION_WARNING=subscription_suspension_warning_1day_2v_hxfcc8ae438db9df662a0e1f7d801e946b
```

### Enviar Template Manualmente

**Endpoint:** `POST /api/whatsapp/send`

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

**Ejemplo de request (Advertencia de Suspensión):**
```json
{
  "to": "+584123456789",
  "templateName": "subscription_suspension_warning_1day_2v_hxfcc8ae438db9df662a0e1f7d801e946b",
  "variables": {
    "1": "Adrianfer",
    "2": "KIT29JD9M291",
    "3": "2026-02-29"
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

### Envío Automático (Scheduler)

El scheduler (`src/infrastructure/scheduler.ts`) envía automáticamente los templates:

```typescript
// Recordatorio de pago (3 días antes)
await sendWhatsAppNotification(client, subscription, currentPeriod, 'reminder');

// Advertencia de suspensión (cuando se suspende)
await sendWhatsAppNotification(client, subscription, currentPeriod, 'suspension');
```

La función `sendWhatsAppNotification` construye las variables automáticamente:

```typescript
// Para recordatorio
variables = {
  '1': client.name,
  '2': endDateStr, // YYYY-MM-DD
};

// Para suspensión
variables = {
  '1': client.name,
  '2': subscription.kitNumber,
  '3': endDateStr, // YYYY-MM-DD
};
```

---

## Reglas de WhatsApp/Twilio

### Ventana de 24 horas
- **Dentro de las 24 horas:** Puedes enviar mensajes libres si el usuario inició la conversación
- **Fuera de las 24 horas:** Solo puedes enviar mensajes usando **templates aprobados**

### Templates Aprobados
- Los templates deben ser aprobados por WhatsApp antes de usarlos
- Cada template tiene un `contentSid` único
- Las variables son posicionales: `{1}`, `{2}`, `{3}`, etc.
- Las variables se pasan como un objeto JSON con claves string: `{"1": "valor", "2": "valor"}`

### Limitaciones
- No puedes enviar mensajes promocionales sin aprobación
- Los templates de notificación tienen prioridad de aprobación
- Debes usar los templates exactos aprobados por WhatsApp

---

## Historial de Mensajes

Todos los mensajes (entrantes y salientes) se guardan en Firestore en la colección `whatsappMessages`.

**Ver historial de un cliente:**
```
GET /api/whatsapp/messages/:phone
```

**Ejemplo de response:**
```json
{
  "messages": [
    {
      "id": "id_abc123",
      "clientId": "client_01",
      "phone": "+584123456789",
      "direction": "OUTBOUND",
      "messageSid": "SM1234567890abcdef",
      "body": "[Template: subscription_reminder_3days_2v...] Variables: {\"1\":\"Adrianfer\",\"2\":\"2026-02-29\"}",
      "templateName": "subscription_reminder_3days_2v_hxfcc8ae438db9df662a0e1f7d801e946b",
      "status": "SENT",
      "createdAt": "2026-02-26T10:00:00.000Z"
    }
  ],
  "total": 1
}
```

---

## Configuración en Twilio Console

1. Ve a [Twilio Console](https://console.twilio.com)
2. **Messaging** → **Try it out** → **WhatsApp sandbox** o tu número
3. Configura el webhook:
   - **URL:** `https://tu-dominio.com/communications/webhook`
   - **Método:** `POST`
4. Guarda los cambios

---

## Notas Importantes

- Los templates usan variables **posicionales**, no por nombre
- El formato de fecha debe ser `YYYY-MM-DD`
- El número de teléfono debe incluir el código de país (ej: `+584123456789`)
- Todos los mensajes se guardan en Firestore para auditoría
- El scheduler se ejecuta diariamente según el cron configurado en `CRON_SCHEDULE`
