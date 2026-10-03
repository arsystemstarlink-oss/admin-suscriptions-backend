export function stripUndefined<T>(value: T): T {
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const cleaned: Record<string, unknown> = {};
    Object.keys(value as Record<string, unknown>).forEach((key) => {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        cleaned[key] = stripUndefined(entry);
      }
    });
    return cleaned as unknown as T;
  }
  return value;
}
