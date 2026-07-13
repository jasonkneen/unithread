import { UnifiedWorker, Transferable_ } from "./worker.js";

/**
 * The worker-side bootstrap. Runs unmodified in BOTH:
 *  - a Node eval-worker (CommonJS context, `require`, no `self`)
 *  - a browser Blob-URL worker (`self` present)
 *
 * Protocol (structured-clone-safe):
 *   in : { id, type: "call", args } | { id, type: "method", name, args }
 *   out: { id, ok: true, value }
 *      | { id, ok: false, error: { message, stack, name } }
 *      | { type: "event", event, data }            (fire-and-forget stream)
 *
 * Worker-side helpers (available as the injected env AND as
 * `globalThis.__unithread` for service methods):
 *   env.emit(event, data, transfer?)  -> stream an event to the main thread
 *   env.transfer(value, list)         -> mark a return value's transferables
 */
export function _bootstrap(exportedSource: string): string {
  return `
(function () {
  "use strict";
  var IS_NODE_WORKER = typeof self === "undefined";
  var post, on, env;
  if (IS_NODE_WORKER) {
    var wt = require("node:worker_threads");
    post = function (m, t) { wt.parentPort.postMessage(m, t || []); };
    on = function (cb) { wt.parentPort.on("message", cb); };
    env = { isMainThread: wt.isMainThread, threadId: wt.threadId, runtime: "node" };
  } else {
    post = function (m, t) { self.postMessage(m, t || []); };
    on = function (cb) { self.onmessage = function (e) { cb(e.data); }; };
    env = { isMainThread: false, threadId: -1, runtime: "web" };
  }

  // Non-enumerable so env itself stays structured-clone-safe if user
  // code returns or re-posts it (functions would otherwise throw).
  Object.defineProperty(env, "emit", { value: function (event, data, transfer) {
    post({ type: "event", event: event, data: data }, transfer || []);
  }});
  Object.defineProperty(env, "transfer", { value: function (value, list) {
    return { __unithreadTransfer: true, value: value, transfer: list || [] };
  }});
  globalThis.__unithread = env;

  var __exported = (${exportedSource});

  function reply(id, p) {
    Promise.resolve(p).then(
      function (value) {
        var transfer = [];
        if (value && value.__unithreadTransfer) {
          transfer = value.transfer; value = value.value;
        }
        post({ id: id, ok: true, value: value }, transfer);
      },
      function (err) {
        post({ id: id, ok: false, error: {
          message: err && err.message ? err.message : String(err),
          stack: err && err.stack ? err.stack : undefined,
          name: err && err.name ? err.name : "Error"
        }});
      }
    );
  }

  on(function (msg) {
    if (!msg || typeof msg.id === "undefined") return;
    try {
      if (msg.type === "call") {
        reply(msg.id, __exported.apply(null, (msg.args || []).concat([env])));
      } else if (msg.type === "method") {
        var target = __exported[msg.name];
        if (typeof target !== "function") throw new Error("No such method: " + msg.name);
        reply(msg.id, target.apply(__exported, msg.args || []));
      }
    } catch (err) { reply(msg.id, Promise.reject(err)); }
  });

  post({ id: "__ready__", ok: true, value: {
    isMainThread: env.isMainThread, threadId: env.threadId, runtime: env.runtime
  } });
})();
`;
}

export interface WorkerEnv {
  isMainThread: boolean;
  threadId: number;
  runtime: "node" | "web";
  /** Stream a fire-and-forget event to the main thread. */
  emit(event: string, data?: any, transfer?: Transferable_[]): void;
  /** Wrap a return value so listed buffers are transferred, not copied. */
  transfer<T>(value: T, list: Transferable_[]): T;
}

export type EventHandler = (event: string, data: any) => void;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

/**
 * A handle to a live thread running one shipped function (or a service
 * object of functions). Call it repeatedly; terminate when done.
 *
 * IMPORTANT: shipped code crosses the thread boundary via
 * `Function.prototype.toString()`. It must be self-contained — no closure
 * captures, no outer imports. Data arrives via arguments, SharedArrayBuffer,
 * or transferred buffers.
 */
export class Task<TArgs extends any[] = any[], TResult = any> {
  private seq = 0;
  private pending = new Map<string, Pending>();
  private eventHandlers: EventHandler[] = [];

  private constructor(
    private readonly worker: UnifiedWorker,
    public readonly env: Pick<WorkerEnv, "isMainThread" | "threadId" | "runtime">,
  ) {}

  static async spawn<TArgs extends any[], TResult>(
    fn: (...args: [...TArgs, WorkerEnv]) => TResult | Promise<TResult>,
  ): Promise<Task<TArgs, TResult>> {
    return Task.fromSource(fn.toString());
  }

  /**
   * Ship an object of named functions; invoke with `task.call(name, args)`
   * or wrap in a proxy via `wrap(task)`. Each function must be
   * self-contained. `globalThis.__unithread.emit` is available inside.
   */
  static async spawnService(
    methods: Record<string, (...args: any[]) => any>,
  ): Promise<Task<any[], any>> {
    const body = Object.entries(methods)
      .map(([name, fn]) => JSON.stringify(name) + ": (" + fn.toString() + ")")
      .join(",\n");
    return Task.fromSource("{\n" + body + "\n}");
  }

  private static async fromSource(exportedSource: string): Promise<Task<any, any>> {
    const worker = await UnifiedWorker.fromSource(_bootstrap(exportedSource));
    const env = await new Promise<any>((resolve, reject) => {
      worker.onError(reject);
      worker.onMessage(function ready(msg: any) {
        if (msg?.id === "__ready__") resolve(msg.value);
      });
    });
    const task = new Task<any, any>(worker, env);
    worker.onMessage((msg: any) => task.dispatch(msg));
    worker.onError((err) => task.failAll(err));
    return task;
  }

  private dispatch(msg: any): void {
    if (!msg || msg.id === "__ready__") return;
    if (msg.type === "event") {
      for (const h of this.eventHandlers) h(msg.event, msg.data);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else {
      const e = new Error(msg.error?.message ?? "Worker error");
      if (msg.error?.stack) e.stack = msg.error.stack;
      if (msg.error?.name) e.name = msg.error.name;
      p.reject(e);
    }
  }

  private failAll(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  /** Invoke the shipped function on its thread. */
  run(args: TArgs, transfer: Transferable_[] = []): Promise<TResult> {
    return this.send({ type: "call", args }, transfer);
  }

  /** Invoke a named method of a shipped service object. */
  call<R = any>(name: string, args: any[] = [], transfer: Transferable_[] = []): Promise<R> {
    return this.send({ type: "method", name, args }, transfer);
  }

  /** Subscribe to worker-emitted stream events; returns unsubscribe. */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const i = this.eventHandlers.indexOf(handler);
      if (i >= 0) this.eventHandlers.splice(i, 1);
    };
  }

  private send(body: object, transfer: Transferable_[]): Promise<any> {
    const id = `m${this.seq++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...body }, transfer);
    });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  terminate(): Promise<void> {
    this.failAll(new Error("Task terminated"));
    return this.worker.terminate();
  }
}

/** One-shot convenience: spawn, run once, terminate. */
export async function runInThread<TArgs extends any[], TResult>(
  fn: (...args: [...TArgs, WorkerEnv]) => TResult | Promise<TResult>,
  ...args: TArgs
): Promise<TResult> {
  const task = await Task.spawn(fn);
  try {
    return await task.run(args);
  } finally {
    await task.terminate();
  }
}
