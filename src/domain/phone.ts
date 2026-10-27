import { BusinessError } from './entities';

export const VENEZUELAN_COUNTRY_CODE = '58';
export const VENEZUELAN_NATIONAL_MIN_DIGITS = 10;
export const VENEZUELAN_NATIONAL_MAX_DIGITS = 11;

/**
 * Devuelve el número nacional venezolano sin código de país ni 0 troncal.
 * Acepta +58, 0058, 0 inicial y separadores. No valida longitud.
 */
export function normalizeVenezuelanPhoneDigits(value: string | null | undefined): string {
  let digits = String(value ?? '').replace(/\D/g, '');

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  if (digits.startsWith(VENEZUELAN_COUNTRY_CODE)) {
    digits = digits.slice(VENEZUELAN_COUNTRY_CODE.length);
  }
  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return digits.slice(0, VENEZUELAN_NATIONAL_MAX_DIGITS);
}

export function isValidVenezuelanNationalDigits(digits: string): boolean {
  return (
    digits.length >= VENEZUELAN_NATIONAL_MIN_DIGITS &&
    digits.length <= VENEZUELAN_NATIONAL_MAX_DIGITS &&
    /^\d+$/.test(digits)
  );
}

export function normalizePhoneToE164(value: string): string {
  const national = normalizeVenezuelanPhoneDigits(value);

  if (!isValidVenezuelanNationalDigits(national)) {
    throw new BusinessError('INVALID_PHONE', 'Número de teléfono inválido.');
  }

  return `+${VENEZUELAN_COUNTRY_CODE}${national}`;
}

export function phonesMatch(a: string, b: string): boolean {
  const nationalA = normalizeVenezuelanPhoneDigits(a);
  const nationalB = normalizeVenezuelanPhoneDigits(b);

  if (
    !isValidVenezuelanNationalDigits(nationalA) ||
    !isValidVenezuelanNationalDigits(nationalB)
  ) {
    return false;
  }

  if (nationalA === nationalB) return true;

  const tail = Math.min(nationalA.length, nationalB.length);
  if (tail < VENEZUELAN_NATIONAL_MIN_DIGITS) return false;

  return nationalA.slice(-tail) === nationalB.slice(-tail);
}
