import { normalizeDni, isValidDni } from '../domain/business-rules';
import {
  normalizePhoneDigits,
  phonesMatch,
  maskPhone,
  maskEmail,
  validateReportPaymentMethod,
  validateReportPaidAt,
} from '../domain/payment-reports';
import { normalizePhoneToE164 } from '../domain/phone';
import { parseBusinessPaymentDate } from '../domain/payment-date';
import { isPaymentMethod, PAYMENT_METHODS, validatePaymentMethod } from '../domain/payment-methods';

describe('payment-reports helpers', () => {
  describe('phone normalization', () => {
    it.each([
      ['+58 0412 1234567', '+584121234567', '4121234567'],
      ['0058 0412 1234567', '+584121234567', '4121234567'],
      ['0412-123-45-67', '+584121234567', '4121234567'],
      ['4121234567', '+584121234567', '4121234567'],
    ])('normaliza %s a E164', (input, e164, national) => {
      expect(normalizePhoneToE164(input)).toBe(e164);
      expect(normalizePhoneDigits(input)).toBe(national);
    });

    it('rechaza números demasiado cortos', () => {
      expect(() => normalizePhoneToE164('0412')).toThrow('Número de teléfono inválido.');
    });

    it.each(['+57 300 123 4567', '0057 300 123 4567', '573001234567'])(
      'preserva el código colombiano al normalizar %s',
      (input) => {
        expect(normalizePhoneToE164(input)).toBe('+573001234567');
      },
    );

    it('rechaza un número colombiano internacional con longitud inválida', () => {
      expect(() => normalizePhoneToE164('+57 300 123 456')).toThrow(
        'Número de teléfono inválido.',
      );
    });

    it.each([
      ['+573001234567', '+573001234567'],
      ['0055 11 98765-4321', '+5511987654321'],
      ['+5511987654321', '+5511987654321'],
      ['+5491123456789', '+5491123456789'],
      ['+584121234567', '+584121234567'],
      ['+59171234567', '+59171234567'],
      ['+56912345678', '+56912345678'],
    ])('valida y conserva el E.164 de los países admitidos: %s', (input, expected) => {
      expect(normalizePhoneToE164(input)).toBe(expected);
    });

    it('rechaza códigos de país que no están habilitados', () => {
      expect(() => normalizePhoneToE164('+12025550123')).toThrow(
        'Número de teléfono inválido.',
      );
    });
  });

  describe('phonesMatch', () => {
    it('coincide E.164 con formato legacy local', () => {
      expect(phonesMatch('+584141005606', '04141005606')).toBe(true);
      expect(phonesMatch('+584141005606', '4141005606')).toBe(true);
      expect(phonesMatch('0414-100-56-06', '+58 414 100 56 06')).toBe(true);
    });

    it('rechaza telefonos distintos o vacios', () => {
      expect(phonesMatch('+584141005606', '+584241005606')).toBe(false);
      expect(phonesMatch('', '+584141005606')).toBe(false);
      expect(phonesMatch('+584141005606', '')).toBe(false);
    });

    it('no acepta coincidencias parciales de menos de 10 dígitos', () => {
      expect(phonesMatch('+584141005606', '41005606')).toBe(false);
    });

    it('compara números E.164 considerando el código de país', () => {
      expect(phonesMatch('+573001234567', '+573001234567')).toBe(true);
      expect(phonesMatch('+573001234567', '+583001234567')).toBe(false);
    });
  });

  describe('masking', () => {
    it('enmascara telefono dejando ultimos 4', () => {
      expect(maskPhone('+584141005606')).toBe('••••5606');
    });

    it('enmascara email sin exponer local completo', () => {
      expect(maskEmail('juan@example.com')).toBe('j•••@example.com');
      expect(maskEmail(undefined)).toBeUndefined();
    });
  });

  describe('dni + metodo + fecha', () => {
    it('normaliza y valida cedula', () => {
      expect(isValidDni(normalizeDni('v-2769383'))).toBe(true);
      expect(isValidDni(normalizeDni('9279238239'))).toBe(false);
    });

    it('rechaza INITIAL_PAYMENT como metodo de reporte', () => {
      expect(() => validateReportPaymentMethod('INITIAL_PAYMENT')).toThrow();
      expect(() => validateReportPaymentMethod('TRANSFER')).not.toThrow();
    });

    it('expone una lista unica de metodos de pago', () => {
      expect(PAYMENT_METHODS).toEqual(['CASH', 'TRANSFER', 'USDT', 'CARD', 'OTHER']);
      expect(isPaymentMethod('CASH')).toBe(true);
      expect(isPaymentMethod('INITIAL_PAYMENT')).toBe(false);
      expect(() => validatePaymentMethod('INITIAL_PAYMENT')).toThrow('Método de pago inválido.');
    });

    it('parsea fechas de pago y rechaza futuras', () => {
      const now = new Date('2026-10-27T12:00:00.000Z');
      expect(parseBusinessPaymentDate('2026-10-27', now).toISOString()).toBe('2026-10-27T12:00:00.000Z');
      expect(() => parseBusinessPaymentDate('2026-10-28', now)).toThrow('no puede ser futura');
      expect(() => parseBusinessPaymentDate('', now)).toThrow('obligatoria');
      expect(
        parseBusinessPaymentDate('2026-12-01', now, { allowFuture: true }).toISOString()
      ).toBe('2026-12-01T12:00:00.000Z');
    });

    it('valida paidAt contra inicio del periodo y futuro', () => {
      const start = new Date(Date.UTC(2026, 7, 5));
      expect(() => validateReportPaidAt('2026-08-04', start)).toThrow();
      expect(() => validateReportPaidAt('2026-08-05', start)).not.toThrow();
      expect(() => validateReportPaidAt('2099-01-01', start)).toThrow();
      expect(() => validateReportPaidAt('no-fecha', start)).toThrow();
    });
  });
});
