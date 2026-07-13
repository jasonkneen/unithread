import { Task, WorkerEnv } from "./spawn.js";
import { hardwareConcurrency } from "./runtime.js";
import { Transferable_ } from "./worker.js";

interface QueueItem {
  args: any[];
  transfer: Transferable_[];
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

/**
 * Fixed pool of threads all running the same shipped function.
 * FIFO queue, one in-flight job per thread, lazy worker startup.
 */
export class WorkerPool<TArgs extends any[] = any[], TResult = any> {
  private idle: Task<TArgs, TResult>[] = [];
  private all: Task<TArgs, TResult>[] = [];
  private queue: QueueItem[] = [];
  private spawning = 0;
  private closed = false;

  private constructor(
    private readonly fn: (...args: [...TArgs, WorkerEnv]) => TResult | Promise<TResult>,
    public readonly size: number,
  ) {}

  static async create<TArgs extends any[], TResult>(
    fn: (...args: [...TArgs, WorkerEnv]) => TResult | Promise<TResult>,
    size?: number,
  ): Promise<WorkerPool<TArgs, TResult>> {
    const n = size ?? (await hardwareConcurrency());
    return new WorkerPool<TArgs, TResult>(fn, Math.max(1, n));
  }

  /** Enqueue one invocation; resolves when a thread has produced the result. */
  exec(args: TArgs, transfer: Transferable_[] = []): Promise<TResult> {
    if (this.closed) return Promise.reject(new Error("Pool closed"));
    return new Promise<TResult>((resolve, reject) => {
      this.queue.push({ args, transfer, resolve, reject });
      this.pump();
    });
  }

  /** Parallel map with pool-bounded concurrency, order preserved. */
  map<TItem>(items: TItem[], toArgs: (item: TItem, i: number) => TArgs): Promise<TResult[]> {
    return Promise.all(items.map((item, i) => this.exec(toArgs(item, i))));
  }

  private pump(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const job = this.queue.shift()!;
      const task = this.idle.pop()!;
      task
        .run(job.args as TArgs, job.transfer)
        .then(job.resolve, job.reject)
        .finally(() => {
          if (!this.closed) {
            this.idle.push(task);
            this.pump();
          }
        });
    }
    // Lazily grow to `size` while there is unmet demand.
    if (
      this.queue.length > 0 &&
      this.all.length + this.spawning < this.size
    ) {
      this.spawning++;
      Task.spawn(this.fn)
        .then((task) => {
          this.spawning--;
          if (this.closed) return void task.terminate();
          this.all.push(task);
          this.idle.push(task);
          this.pump();
        })
        .catch((err) => {
          this.spawning--;
          // Fail queued work if we can never run it (no workers at all).
          if (this.all.length === 0) {
            const q = this.queue.splice(0);
            for (const job of q) job.reject(err);
          }
        });
    }
  }

  /** Threads actually started (grows lazily up to `size`). */
  get started(): number {
    return this.all.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    const q = this.queue.splice(0);
    for (const job of q) job.reject(new Error("Pool closed"));
    await Promise.all(this.all.map((t) => t.terminate()));
    this.all = [];
    this.idle = [];
  }
}
