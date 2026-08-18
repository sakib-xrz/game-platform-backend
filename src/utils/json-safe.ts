export const toJsonSafe = <T>(value: T): T => {
  if (typeof value === 'bigint') return value.toString() as T;
  if (value instanceof Date) return value.toISOString() as T;
  if (Array.isArray(value)) return value.map(toJsonSafe) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toJsonSafe(item),
      ]),
    ) as T;
  }
  return value;
};
