import { BusinessError } from './entities';

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validatePasswordStrength(password: string): void {
  if (password.length < 8) {
    throw new BusinessError('WEAK_PASSWORD', 'La contraseña debe tener al menos 8 caracteres.');
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new BusinessError('WEAK_PASSWORD', 'La contraseña debe incluir letras y números.');
  }
}
