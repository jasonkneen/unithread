/**
 * Shared-memory primitives over SharedArrayBuffer + Atomics.
 * These are the only true shared state across JS threads; everything else
 * is copied via structured clone.
 *
 * Browser note: SharedArrayBuffer requires cross-origin isolation
 * (COOP/COEP headers), and Atomics.wait is forbidden on the browser main
 * thread — use waitAsync there. Node has no such restriction.
 */

function assertShared(): void {
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error(
      "SharedArrayBuffer unavailable. In browsers this requires cross-origin isolation (COOP/COEP).",
    );
  }
}

/** Lock-free atomic counter shared across threads. */
export class SharedCounter {
  readonly buffer: SharedArrayBuffer;
  private readonly view: Int32Array;

  constructor(bufferOrInitial: SharedArrayBuffer | number = 0) {
    if (bufferOrInitial instanceof SharedArrayBuffer) {
      this.buffer = bufferOrInitial;
    } else {
      assertShared();
      this.buffer = new SharedArrayBuffer(4);
      new Int32Array(this.buffer)[0] = bufferOrInitial;
    }
    this.view = new Int32Array(this.buffer);
  }

  add(n = 1): number {
    return Atomics.add(this.view, 0, n) + n;
  }

  get value(): number {
    return Atomics.load(this.view, 0);
  }
}

/**
 * A mutex usable from any thread that may block (Node anywhere; browser
 * workers only — never the browser main thread, use lockAsync there).
 */
export class Mutex {
  static readonly UNLOCKED = 0;
  static readonly LOCKED = 1;
  readonly buffer: SharedArrayBuffer;
  private readonly view: Int32Array;

  constructor(buffer?: SharedArrayBuffer) {
    if (buffer) {
      this.buffer = buffer;
    } else {
      assertShared();
      this.buffer = new SharedArrayBuffer(4);
    }
    this.view = new Int32Array(this.buffer);
  }

  /** Blocking acquire. */
  lock(): void {
    for (;;) {
      if (
        Atomics.compareExchange(this.view, 0, Mutex.UNLOCKED, Mutex.LOCKED) ===
        Mutex.UNLOCKED
      )
        return;
      Atomics.wait(this.view, 0, Mutex.LOCKED);
    }
  }

  /** Non-blocking acquire; true on success. */
  tryLock(): boolean {
    return (
      Atomics.compareExchange(this.view, 0, Mutex.UNLOCKED, Mutex.LOCKED) ===
      Mutex.UNLOCKED
    );
  }

  /** Async acquire — safe on the browser main thread (Atomics.waitAsync). */
  async lockAsync(): Promise<void> {
    for (;;) {
      if (this.tryLock()) return;
      const w = (Atomics as any).waitAsync?.(this.view, 0, Mutex.LOCKED);
      if (w?.async) await w.value;
      else await new Promise((r) => setTimeout(r, 0)); // fallback spin-yield
    }
  }

  unlock(): void {
    Atomics.store(this.view, 0, Mutex.UNLOCKED);
    Atomics.notify(this.view, 0, 1);
  }

  /** Run `fn` under the lock (blocking variant). */
  withLock<T>(fn: () => T): T {
    this.lock();
    try {
      return fn();
    } finally {
      this.unlock();
    }
  }
}

/** One-shot cross-thread signal: one side waits, another fires. */
export class Signal {
  readonly buffer: SharedArrayBuffer;
  private readonly view: Int32Array;

  constructor(buffer?: SharedArrayBuffer) {
    if (buffer) {
      this.buffer = buffer;
    } else {
      assertShared();
      this.buffer = new SharedArrayBuffer(4);
    }
    this.view = new Int32Array(this.buffer);
  }

  /** Blocking wait (Node / browser worker). Returns false on timeout. */
  wait(timeoutMs = Infinity): boolean {
    if (Atomics.load(this.view, 0) !== 0) return true;
    return Atomics.wait(this.view, 0, 0, timeoutMs) !== "timed-out";
  }

  /** Async wait — safe everywhere. */
  async waitAsync(timeoutMs = Infinity): Promise<boolean> {
    if (Atomics.load(this.view, 0) !== 0) return true;
    const w = (Atomics as any).waitAsync?.(this.view, 0, 0, timeoutMs);
    if (w?.async) return (await w.value) !== "timed-out";
    if (w) return w.value !== "timed-out";
    // Fallback poll
    const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 2 ** 31);
    while (Date.now() < deadline) {
      if (Atomics.load(this.view, 0) !== 0) return true;
      await new Promise((r) => setTimeout(r, 1));
    }
    return false;
  }

  fire(): void {
    Atomics.store(this.view, 0, 1);
    Atomics.notify(this.view, 0);
  }
}
