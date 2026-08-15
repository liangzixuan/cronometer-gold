/**
 * Runtime-freeze JSON-like domain output so a stored calculation cannot be
 * accidentally changed by a caller after it has been resolved.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  const seen = new WeakSet<object>();

  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) {
      return;
    }

    seen.add(candidate);
    for (const child of Object.values(candidate)) {
      freeze(child);
    }
    Object.freeze(candidate);
  };

  freeze(value);
  return value;
}
