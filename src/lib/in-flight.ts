export function createInFlightDeduplicator() {
  const pending = new Map<string, Promise<unknown>>();

  return function deduplicate<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const current = pending.get(key) as Promise<T> | undefined;
    if (current) return current;

    const shared = operation().finally(() => {
      pending.delete(key);
    });
    pending.set(key, shared);
    return shared;
  };
}
