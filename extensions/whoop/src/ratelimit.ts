// WHOOP's limits are 100 requests a minute and 10,000 a day per app (developer.whoop.com, "Rate Limiting"), shared
// with anything else using the same app (the dashboard during parity). This gate keeps the extension well under them:
// - a token bucket (burst 20, refill 60 a minute), so a cold load of a long history is spread out;
// - a daily budget (5,000 a UTC day), after which calls fail as rate_limited instead of eating the app's quota;
// - a shared "blocked until" after a 429 (Retry-After or X-RateLimit-Reset, plus jitter): every request waits for it,
//   so concurrent calls can't stampede WHOOP the moment it says stop, and the burst restarts small after it;
// - at most 2 requests in flight.

export interface RateGateOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  capacity?: number;
  refillPerMinute?: number;
  dailyBudget?: number;
  maxConcurrent?: number;
  /** A request that would have to wait longer than this fails as rate_limited instead. */
  maxWaitMs?: number;
}

export class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("rate_limited");
    this.name = "RateLimitedError";
  }
}

export class RateGate {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly dailyBudget: number;
  private readonly maxConcurrent: number;
  readonly maxWaitMs: number;
  private tokens: number;
  private refilledAt: number;
  private blockedUntil = 0;
  private day = "";
  private usedToday = 0;
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(opts: RateGateOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.capacity = opts.capacity ?? 20;
    this.refillPerMs = (opts.refillPerMinute ?? 60) / 60_000;
    this.dailyBudget = opts.dailyBudget ?? 5_000;
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.maxWaitMs = opts.maxWaitMs ?? 20_000;
    this.tokens = this.capacity;
    this.refilledAt = this.now();
  }

  /** Requests counted today (UTC), for status and tests. */
  get used(): number {
    this.rollDay();
    return this.usedToday;
  }

  /** WHOOP said 429: nobody sends anything until `ms` (plus up to 20% jitter, at least 250 ms) has passed. */
  block(ms: number): number {
    const jitter = Math.max(250, ms * 0.2 * this.random());
    const until = this.now() + ms + jitter;
    if (until > this.blockedUntil) this.blockedUntil = until;
    // Restart slowly after the block: a small burst, then the refill rate.
    this.tokens = Math.min(this.tokens, 5);
    this.refilledAt = this.now();
    return this.blockedUntil - this.now();
  }

  /** Runs `fn` once a token, a slot and the 429 block allow it. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.slot();
    try {
      await this.token();
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async slot(): Promise<void> {
    while (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
  }

  private rollDay(): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.usedToday = 0;
    }
  }

  private async token(): Promise<void> {
    const started = this.now();
    for (;;) {
      this.rollDay();
      if (this.usedToday >= this.dailyBudget) {
        const tomorrow = Date.parse(`${this.day}T00:00:00Z`) + 86_400_000;
        throw new RateLimitedError(tomorrow - this.now());
      }
      const t = this.now();
      this.tokens = Math.min(this.capacity, this.tokens + (t - this.refilledAt) * this.refillPerMs);
      this.refilledAt = t;
      let wait = 0;
      if (this.blockedUntil > t) wait = this.blockedUntil - t;
      else if (this.tokens < 1) wait = Math.ceil((1 - this.tokens) / this.refillPerMs);
      if (wait === 0) {
        this.tokens -= 1;
        this.usedToday++;
        return;
      }
      if (t - started + wait > this.maxWaitMs) throw new RateLimitedError(wait);
      await this.sleep(wait);
    }
  }
}
