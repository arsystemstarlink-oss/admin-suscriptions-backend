import { TtlMemoryCache } from '../infrastructure/memory-cache';

describe('TtlMemoryCache', () => {
  it('sirve el valor cacheado dentro del TTL sin volver a cargar', async () => {
    const cache = new TtlMemoryCache(1000);
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return calls;
    };

    expect(await cache.getOrLoad('k', loader)).toBe(1);
    expect(await cache.getOrLoad('k', loader)).toBe(1);
    expect(calls).toBe(1);
  });

  it('deduplica cargas concurrentes (single-flight)', async () => {
    const cache = new TtlMemoryCache(1000);
    let calls = 0;
    const loader = () =>
      new Promise<number>((resolve) =>
        setTimeout(() => {
          calls += 1;
          resolve(calls);
        }, 10)
      );

    const [a, b] = await Promise.all([
      cache.getOrLoad('k', loader),
      cache.getOrLoad('k', loader),
    ]);

    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
  });

  it('recarga cuando expira el TTL', async () => {
    jest.useFakeTimers();
    try {
      const cache = new TtlMemoryCache(100);
      let calls = 0;
      const loader = async () => {
        calls += 1;
        return calls;
      };

      expect(await cache.getOrLoad('k', loader)).toBe(1);
      jest.advanceTimersByTime(150);
      expect(await cache.getOrLoad('k', loader)).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('invalida con delete y clear', async () => {
    const cache = new TtlMemoryCache(1000);
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return calls;
    };

    expect(await cache.getOrLoad('a', loader)).toBe(1);
    cache.delete('a');
    expect(await cache.getOrLoad('a', loader)).toBe(2);

    cache.set('b', 'value');
    expect(cache.get('b')).toBe('value');
    cache.clear();
    expect(cache.get('b')).toBeUndefined();
  });
});
