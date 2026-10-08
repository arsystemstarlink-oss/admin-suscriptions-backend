# WhatsApp Templates - Documentacion

## Configuración por organización

Cada organización configura sus credenciales, Content SID y reglas desde
`GET/PUT /api/whatsapp/config`. La configuración queda guardada en su documento de organización;
el Auth Token nunca se devuelve en la respuesta (solo `authTokenConfigured`). El
administrador solo puede modificar la configuración de su propia organización.

El scheduler es independiente: sigue ejecutando las reglas de suscripciones y pagos
aunque Twilio esté deshabilitado o incompleto. En ese caso no se envía WhatsApp y
`readiness` indica los requisitos pendientes.

Configuración inicial del comportamiento:

- Recordatorio de pago: 3 días antes.
- Aviso de vencimiento: habilitado para el día de corte.
- Aviso de suspensión: habilitado al pasar de `ACTIVE` a `SUSPENDED`.

Estas reglas se pueden cambiar por organización. `reminderDaysBefore` acepta una
lista de días entre 1 y 30; una lista vacía desactiva los recordatorios previos.

### Plantillas disponibles

Los Content SID de las plantillas se configuran por organización; deben corresponder
a plantillas aprobadas y disponibles en la cuenta Twilio de esa organización.

#### Recordatorio de pago

Variables: `{1}` nombre completo del cliente, `{2}` fecha de vencimiento (`YYYY-MM-DD`).

#### Aviso de vencimiento

Variables: `{1}` nombre completo, `{2}` kit, `{3}` fecha de vencimiento (`YYYY-MM-DD`).

#### Aviso de suspensión

- Variables: `{1}` nombre completo, `{2}` kit.

## Resumen de Logica de Notificaciones

| Condicion | Tipo | Template | Variables |
|---|---|---|---|
| `ACTIVE` + `PENDING` + uno de los días configurados | `reminder` | Recordatorio de pago | `{1}` nombre, `{2}` fecha |
| `ACTIVE` + `PENDING` + vencimiento hoy | `suspension-warning` | Aviso de vencimiento | `{1}` nombre, `{2}` kit, `{3}` fecha |
| Cambio a `SUSPENDED` | `suspended-notice` | Aviso de suspensión | `{1}` nombre, `{2}` kit |
| `SUSPENDED` (sin cambio) | — | Silencio | — |

---

## Uso en el Codigo

Las variables de entorno antiguas `TWILIO_TEMPLATE_*` se leen como compatibilidad para
organizaciones que todavía no han guardado configuración de notificaciones. Al guardar
reglas o plantillas, la configuración queda explícita por organización.

### Enviar Template Manualmente

**Endpoint:** `POST /api/whatsapp/send`  
**Auth:** `Authorization: Bearer {accessToken}` (admin JWT obligatorio)

**Ejemplo de request (Recordatorio):**
```json
{
  "to": "+584123456789",
  "templateName": "HX_REMINDER_CONTENT_SID",
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
  "templateName": "HX_SUSPENSION_CONTENT_SID",
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
// Recordatorio (los días previos definidos en reminderDaysBefore)
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

**Status callback (Twilio):**
```
POST /communications/status
```
- Publico (sin JWT admin); envia `MessageStatus` y `MessageSid` en el body
- Actualiza el estado del mensaje (`SENT`, `DELIVERED`, `READ`, `FAILED`) y guarda `errorMessage`
- Configurar en Twilio Console: StatusCallback URL = `{BASE_URL}/communications/status` (metodo POST)
- Valida firma con el `authToken` de la organizacion a la que pertenece el mensaje

---

## Notas Importantes

- Los templates usan variables **posicionales**, no por nombre
- El formato de fecha debe ser `YYYY-MM-DD`
- El numero de telefono debe incluir el codigo de pais (ej: `+584123456789`)
- Todos los mensajes se guardan en Firestore para auditoria
- El scheduler se ejecuta diariamente segun el cron configurado en `CRON_SCHEDULE`
- `send` e historial requieren JWT de admin; solo el webhook de Twilio es público
