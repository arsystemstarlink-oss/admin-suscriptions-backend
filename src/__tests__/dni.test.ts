import { normalizeDni, isValidDni } from '../domain/business-rules';

describe('normalizeDni', () => {
  it('debería normalizar a formato canónico V-/J- con guion', () => {
    expect(normalizeDni('v-2769383')).toBe('V-2769383');
    expect(normalizeDni(' V-2769383 ')).toBe('V-2769383');
    expect(normalizeDni('v.12.345.678')).toBe('V-12345678');
    expect(normalizeDni('j-123456789')).toBe('J-123456789');
    expect(normalizeDni('V12345678')).toBe('V-12345678');
  });

  it('debería devolver dígitos sin prefijo si no hay V/J', () => {
    expect(normalizeDni('9279238239')).toBe('9279238239');
    expect(normalizeDni('2769383')).toBe('2769383');
  });

  it('debería devolver cadena vacía si no quedan caracteres válidos', () => {
    expect(normalizeDni('---')).toBe('');
    expect(normalizeDni('E-1234567')).toBe('1234567');
    expect(normalizeDni('G-1234567')).toBe('1234567');
  });
});

describe('isValidDni', () => {
  it('debería aceptar cédulas canónicas V-/J- con 7 a 9 dígitos', () => {
    expect(isValidDni('V-2769383')).toBe(true);
    expect(isValidDni('V-12345678')).toBe(true);
    expect(isValidDni('J-123456789')).toBe(true);
    expect(isValidDni('V-1234567')).toBe(true);
  });

  it('debería rechazar formatos no canónicos', () => {
    expect(isValidDni('')).toBe(false);
    expect(isValidDni('9279238239')).toBe(false);
    expect(isValidDni('2769383')).toBe(false);
    expect(isValidDni('V12345678')).toBe(false);
    expect(isValidDni('V-123456')).toBe(false);
    expect(isValidDni('V-1234567890')).toBe(false);
    expect(isValidDni('E-1234567')).toBe(false);
    expect(isValidDni('G-1234567')).toBe(false);
    expect(isValidDni('v-2769383')).toBe(false);
    expect(isValidDni('V-12345 678')).toBe(false);
  });
});
