interface Bucket { count: number; until: number }
/** Bounded fixed-window budget. Capacity pressure never evicts an active client's bucket. */
export class RateWindow {
  private readonly buckets = new Map<string, Bucket>();
  private sweepAt = 0;
  constructor(readonly limit: number, readonly windowMs = 60_000, readonly maxKeys = 10_000) {
    if (![limit, windowMs, maxKeys].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid API rate policy');
  }
  get size(): number { return this.buckets.size; }
  consume(key: string, now: number): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    let bucket = this.buckets.get(key);
    if (bucket && now >= bucket.until) { this.buckets.delete(key); bucket = undefined; }
    if (!bucket && this.buckets.size >= this.maxKeys) {
      if (now >= this.sweepAt) {
        let earliest = Infinity;
        for (const [id, item] of this.buckets) { if (now >= item.until) this.buckets.delete(id); else earliest = Math.min(earliest, item.until); }
        this.sweepAt = Number.isFinite(earliest) ? earliest : now + this.windowMs;
      }
      if (this.buckets.size >= this.maxKeys) return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((this.sweepAt - now) / 1000)) };
    }
    if (!bucket) { bucket = { count: 0, until: now + this.windowMs }; this.buckets.set(key, bucket); this.sweepAt = Math.min(this.sweepAt, bucket.until); }
    const allowed = bucket.count < this.limit;
    if (allowed) bucket.count++;
    return { allowed, remaining: Math.max(0, this.limit - bucket.count), retryAfterSeconds: Math.max(1, Math.ceil((bucket.until - now) / 1000)) };
  }
}
