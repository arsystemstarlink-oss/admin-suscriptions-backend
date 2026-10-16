import { TtlMemoryCache } from './memory-cache';

const BADGES_CACHE_TTL_MS = Number(process.env.BADGES_CACHE_TTL_MS || 30000);

/**
 * Caché de los contadores de badges por organización. Evita que varios admins
 * disparen las mismas agregaciones `count()` dentro de la ventana TTL.
 */
export const badgesCache = new TtlMemoryCache(BADGES_CACHE_TTL_MS);

/** Invalida los contadores de una organización (o todos si no se indica). */
export function invalidateBadges(organizationId?: string): void {
  if (!organizationId) {
    badgesCache.clear();
    return;
  }
  badgesCache.delete(organizationId);
}
