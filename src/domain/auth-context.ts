import { UserRole } from './entities';

export interface AuthContext {
  userId: string;
  role: UserRole;
  organizationId: string | null;
}

export const SUPER_ADMIN_ROLE: UserRole = 'super-admin';
export const ADMIN_ROLE: UserRole = 'admin';

export function isSuperAdmin(auth: AuthContext): boolean {
  return auth.role === SUPER_ADMIN_ROLE;
}

export function isAdmin(auth: AuthContext): boolean {
  return auth.role === ADMIN_ROLE;
}
