import {
  buildTemplateSamples,
  buildTemplateVariables,
  formatWhatsAppCurrency,
  formatWhatsAppDate,
  getTemplateText,
  resolveActiveTemplateKey,
  WHATSAPP_CURRENT_TEMPLATE_KEYS,
  WHATSAPP_LEGACY_TEMPLATE_KEYS,
} from '../domain/whatsapp-templates';

describe('plantillas de cobranza', () => {
  it('mantiene diez plantillas actuales y tres anteriores', () => {
    expect(WHATSAPP_CURRENT_TEMPLATE_KEYS).toHaveLength(10);
    expect(WHATSAPP_LEGACY_TEMPLATE_KEYS).toEqual(['reminder', 'dueDateWarning', 'suspensionNotice']);
  });

  it('formatea montos y fechas igual que el frontend', () => {
    expect(formatWhatsAppCurrency(50)).toBe('USD\u00A050,00');
    expect(formatWhatsAppDate('2026-12-15')).toBe('15 dic 2026');
  });

  it('conserva el texto exacto de la confirmación de pago', () => {
    expect(getTemplateText('paymentConfirmation').defaultBody).toBe(
      'Hola {{1}}, tu pago de {{3}} del período {{4}} para el servicio {{5}} fue registrado por {{2}}. Estado del servicio: {{6}}. Tu servicio queda cubierto hasta el {{7}}. Gracias por tu pago. Puedes ver tu cuenta con el botón.'
    );
    expect(buildTemplateVariables('paymentConfirmation', {
      clientName: 'Ana',
      organizationName: 'ORG',
      amount: 'USD\u00A050,00',
      periodLabel: 'Diciembre 2026',
      serviceCode: 'KIT1',
      serviceStatus: 'Activo',
      coveredUntil: '15 ene 2027',
      portalSlug: 'org',
    })).toEqual({
      '1': 'Ana',
      '2': 'ORG',
      '3': 'USD\u00A050,00',
      '4': 'Diciembre 2026',
      '5': 'KIT1',
      '6': 'Activo',
      '7': '15 ene 2027',
      '8': 'org',
    });
  });

  it('elige la variante según el DNI y cae a la anterior solo si no hay V2', () => {
    const templates = {
      reminderV2: 'HX_button',
      reminderV2NoButton: 'HX_plain',
      reminder: 'HX_legacy',
    };
    expect(resolveActiveTemplateKey({ templates }, 'reminder', true)).toBe('reminderV2');
    expect(resolveActiveTemplateKey({ templates }, 'reminder', false)).toBe('reminderV2NoButton');
    expect(resolveActiveTemplateKey({ templates: { reminderV2: 'HX_button' } }, 'reminder', false)).toBeUndefined();
    expect(resolveActiveTemplateKey({ templates: { reminderV2: 'HX_button', reminder: 'HX_legacy' } }, 'reminder', true)).toBe('reminderV2');
    expect(resolveActiveTemplateKey({ templates: { reminder: 'HX_legacy' } }, 'reminder', true)).toBe('reminder');
    expect(resolveActiveTemplateKey({ templates: {} }, 'reminder', true)).toBeUndefined();
  });

  it('usa el ejemplo propio de la plantilla sin cambiar el de la anterior', () => {
    expect(buildTemplateSamples('reminderV2')['6']).toBe('15 dic 2026');
    expect(buildTemplateSamples('reminder')['2']).toBe('2026-12-15');
  });
});
