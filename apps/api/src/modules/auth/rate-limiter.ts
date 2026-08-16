interface AttemptWindow {
  count: number;
  resetAt: number;
}

/** Bounded process-local limiter. A shared edge limiter remains required for multi-instance deploys. */
export class BoundedAuthRateLimiter {
  readonly #attempts = new Map<string, AttemptWindow>();
  readonly #maximumKeys: number;
  readonly #maximumAttempts: number;
  readonly #windowMs: number;

  constructor(options: { maximumKeys?: number; maximumAttempts?: number; windowMs?: number } = {}) {
    this.#maximumKeys = options.maximumKeys ?? 10_000;
    this.#maximumAttempts = options.maximumAttempts ?? 5;
    this.#windowMs = options.windowMs ?? 15 * 60_000;
  }

  consume(key: string, now = Date.now()): boolean {
    const current = this.#attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.#insert(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    if (current.count >= this.#maximumAttempts) return false;
    current.count += 1;
    this.#attempts.delete(key);
    this.#attempts.set(key, current);
    return true;
  }

  reset(key: string): void {
    this.#attempts.delete(key);
  }

  #insert(key: string, value: AttemptWindow): void {
    if (!this.#attempts.has(key) && this.#attempts.size >= this.#maximumKeys) {
      const oldest = this.#attempts.keys().next().value;
      if (oldest !== undefined) this.#attempts.delete(oldest);
    }
    this.#attempts.set(key, value);
  }
}
