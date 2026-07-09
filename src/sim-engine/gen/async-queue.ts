// Minimal single-consumer async queue: producers push() from anywhere (promise
// callbacks, LLM stream callbacks), ONE consumer awaits pop(). Used by the
// generation writer phase to surface chunk results (and, with incremental
// emission, individual scenarios) to the async generator in completion order.
// Pure data structure — no config, no I/O.
export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiter: ((v: T) => void) | null = null;

  push(item: T): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
      return;
    }
    this.buffer.push(item);
  }

  /** Resolves with the next item; FIFO. Only one outstanding pop() at a time
   *  (single consumer) — a second concurrent pop() would clobber the waiter. */
  pop(): Promise<T> {
    if (this.buffer.length > 0) return Promise.resolve(this.buffer.shift()!);
    return new Promise<T>((resolve) => {
      this.waiter = resolve;
    });
  }
}
