import { normalizeDni, isValidDni } from '../domain/business-rules';
import {
  phonesMatch,
  maskPhone,
  maskEmail,
  validateReportPaymentMethod,
  validateReportPaidAt,
} from '../domain/payment-reports';

describe('payment-reports helpers', () => {
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

    it('valida paidAt contra inicio del periodo y futuro', () => {
      const start = new Date(Date.UTC(2026, 7, 5));
      expect(() => validateReportPaidAt('2026-08-04', start)).toThrow();
      expect(() => validateReportPaidAt('2026-08-05', start)).not.toThrow();
      expect(() => validateReportPaidAt('2099-01-01', start)).toThrow();
      expect(() => validateReportPaidAt('no-fecha', start)).toThrow();
    });
  });
});
