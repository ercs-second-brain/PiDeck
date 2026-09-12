/**
 * Fixed-capacity byte ring: keeps the most recent `capacity` bytes of raw
 * pane output so a reconnecting browser replays recent scrollback. Chunks
 * are stored as-is; escape sequences pass through untouched.
 */
export class RingBuffer {
  private chunks: Buffer[] = [];
  private total = 0;

  constructor(readonly capacity: number) {}

  /** Bytes currently retained. */
  get size(): number {
    return this.total;
  }

  /** Appends bytes, dropping the oldest chunks once over capacity. */
  push(chunk: Buffer): void {
    if (this.capacity <= 0 || chunk.length === 0) return;
    let data = chunk;
    if (data.length > this.capacity) data = data.subarray(data.length - this.capacity);
    this.chunks.push(data);
    this.total += data.length;
    while (this.total > this.capacity && this.chunks.length > 1) {
      const oldest = this.chunks[0]!;
      this.chunks.shift();
      this.total -= oldest.length;
    }
  }

  /** Every retained byte, oldest first. */
  replay(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Drops every retained byte. */
  clear(): void {
    this.chunks = [];
    this.total = 0;
  }
}