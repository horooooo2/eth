// Expired values remain available briefly for explicitly stale fallbacks.
class BoundedCache extends Map {
  constructor(limit = 256, staleRetentionMs = 3600000, now = Date.now) {
    super(); this.limit = limit; this.staleRetentionMs = staleRetentionMs; this.now = now;
    this.timer = setInterval(() => this.prune(), 60000);
    this.timer.unref?.();
  }
  prune() {
    const cutoff = this.now() - this.staleRetentionMs;
    for (const [key, entry] of this) if (entry.expiresAt <= cutoff) super.delete(key);
  }
  get(key) {
    const entry = super.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now() - this.staleRetentionMs) { super.delete(key); return undefined; }
    super.delete(key); super.set(key, entry);
    return entry;
  }
  set(key, entry) {
    this.prune(); super.delete(key); super.set(key, entry);
    while (this.size > this.limit) super.delete(this.keys().next().value);
    return this;
  }
}
module.exports = { BoundedCache };
