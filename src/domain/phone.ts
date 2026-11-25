import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { BusinessError } from './entities';

export const VENEZUELAN_COUNTRY_CODE = '58';
export const VENEZUELAN_NATIONAL_MIN_DIGITS = 10;
export const VENEZUELAN_NATIONAL_MAX_DIGITS = 11;
export const SUPPORTED_PHONE_COUNTRIES = ['CO', 'BR', 'AR', 'VE', 'BO', 'CL'] as const;

const supportedPhoneCountries = new Set<string>(SUPPORTED_PHONE_COUNTRIES);

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
  const trimmed = value.trim();
  const internationalInput = trimmed.startsWith('00')
    ? `+${trimmed.slice(2)}`
    : trimmed;
  const hasInternationalPrefix = internationalInput.startsWith('+');
  let parsed = hasInternationalPrefix
    ? parsePhoneNumberFromString(internationalInput)
    : parsePhoneNumberFromString(internationalInput, 'VE');

  if (!parsed?.isValid() && !hasInternationalPrefix) {
    const digits = internationalInput.replace(/\D/g, '');
    parsed = digits ? parsePhoneNumberFromString(`+${digits}`) : undefined;
  }

  if (
    !parsed?.isValid() ||
    !parsed.country ||
    !supportedPhoneCountries.has(parsed.country)
  ) {
    throw new BusinessError('INVALID_PHONE', 'Número de teléfono inválido.');
  }

  return parsed.number;
}

export function phonesMatch(a: string, b: string): boolean {
  const normalizedA = normalizePhoneToE164OrUndefined(a);
  const normalizedB = normalizePhoneToE164OrUndefined(b);
  if (normalizedA && normalizedB) return normalizedA === normalizedB;
  if ((!normalizedA && hasInternationalPrefix(a)) || (!normalizedB && hasInternationalPrefix(b))) {
    return false;
  }

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

function normalizePhoneToE164OrUndefined(value: string): string | undefined {
  try {
    return normalizePhoneToE164(value);
  } catch (error) {
    if (error instanceof BusinessError && error.code === 'INVALID_PHONE') return undefined;
    throw error;
  }
}

function hasInternationalPrefix(value: string): boolean {
  return /^\s*(?:\+|00)/.test(value);
}
