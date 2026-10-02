export class RateLimiter {
  constructor({ limit = 5, windowMs = 60_000, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.users = new Map();
  }

  consume(userId) {
    const now = this.now();
    const current = this.users.get(userId);
    const entry = !current || current.resetTime <= now
      ? { count: 0, resetTime: now + this.windowMs }
      : current;

    if (entry.count >= this.limit) {
      entry.blocked = (entry.blocked || 0) + 1;
      this.users.set(userId, entry);
      return { allowed: false, firstBlock: entry.blocked === 1, remaining: 0, resetTime: entry.resetTime };
    }

    entry.count += 1;
    this.users.set(userId, entry);
    this.cleanup(now);
    return { allowed: true, remaining: this.limit - entry.count, resetTime: entry.resetTime };
  }

  cleanup(now = this.now()) {
    for (const [userId, entry] of this.users) {
      if (entry.resetTime <= now) this.users.delete(userId);
    }
  }
}
