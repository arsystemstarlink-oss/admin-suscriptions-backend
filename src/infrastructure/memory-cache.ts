interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * Caché en memoria con TTL por clave y "single-flight": si varias peticiones
 * piden la misma clave antes de que termine la primera carga, comparten una
 * única ejecución del loader. Pensada para una sola instancia (como el resto de
 * las métricas/cachés del backend).
 */
export class TtlMemoryCache {
  private store = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private defaultTtlMs: number) {}

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number = this.defaultTtlMs): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  async getOrLoad<T>(
    key: string,
    loader: () => Promise<T>,
    ttlMs: number = this.defaultTtlMs
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) {
      return pending;
    }

    const promise = loader()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }
}
