// src/runtime.ts
var isNode = typeof process !== "undefined" && !!process.versions?.node && typeof globalThis.importScripts === "undefined" && typeof globalThis.window === "undefined";
async function hardwareConcurrency() {
  if (isNode) {
    const os = await import("node:os");
    return (os.availableParallelism?.() ?? os.cpus().length) || 1;
  }
  return globalThis.navigator?.hardwareConcurrency || 4;
}
function hasSharedMemory() {
  return typeof SharedArrayBuffer !== "undefined";
}

// src/worker.ts
var UnifiedWorker = class _UnifiedWorker {
  constructor(impl, kind, blobUrl) {
    this.impl = impl;
    this.kind = kind;
    this.blobUrl = blobUrl;
  }
  impl;
  kind;
  blobUrl;
  /** Spawn a real OS thread running `source` (classic script, both runtimes). */
  static async fromSource(source) {
    if (isNode) {
      const { Worker } = await import("node:worker_threads");
      return new _UnifiedWorker(new Worker(source, { eval: true }), "node");
    }
    const url = URL.createObjectURL(
      new Blob([source], { type: "text/javascript" })
    );
    return new _UnifiedWorker(new globalThis.Worker(url), "web", url);
  }
  postMessage(data, transfer = []) {
    if (this.kind === "node") this.impl.postMessage(data, transfer);
    else this.impl.postMessage(data, transfer);
  }
  onMessage(cb) {
    if (this.kind === "node") this.impl.on("message", cb);
    else this.impl.addEventListener("message", (e) => cb(e.data));
  }
  onError(cb) {
    if (this.kind === "node") this.impl.on("error", cb);
    else this.impl.addEventListener("error", (e) => cb(e.error ?? e.message ?? e));
  }
  async terminate() {
    if (this.kind === "node") await this.impl.terminate();
    else {
      this.impl.terminate();
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    }
  }
};

// src/spawn.ts
function _bootstrap(exportedSource) {
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
var Task = class _Task {
  constructor(worker, env) {
    this.worker = worker;
    this.env = env;
  }
  worker;
  env;
  seq = 0;
  pending = /* @__PURE__ */ new Map();
  eventHandlers = [];
  static async spawn(fn) {
    return _Task.fromSource(fn.toString());
  }
  /**
   * Ship an object of named functions; invoke with `task.call(name, args)`
   * or wrap in a proxy via `wrap(task)`. Each function must be
   * self-contained. `globalThis.__unithread.emit` is available inside.
   */
  static async spawnService(methods) {
    const body = Object.entries(methods).map(([name, fn]) => JSON.stringify(name) + ": (" + fn.toString() + ")").join(",\n");
    return _Task.fromSource("{\n" + body + "\n}");
  }
  static async fromSource(exportedSource) {
    const worker = await UnifiedWorker.fromSource(_bootstrap(exportedSource));
    const env = await new Promise((resolve, reject) => {
      worker.onError(reject);
      worker.onMessage(function ready(msg) {
        if (msg?.id === "__ready__") resolve(msg.value);
      });
    });
    const task = new _Task(worker, env);
    worker.onMessage((msg) => task.dispatch(msg));
    worker.onError((err) => task.failAll(err));
    return task;
  }
  dispatch(msg) {
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
  failAll(err) {
    const e = err instanceof Error ? err : new Error(String(err));
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
  /** Invoke the shipped function on its thread. */
  run(args, transfer = []) {
    return this.send({ type: "call", args }, transfer);
  }
  /** Invoke a named method of a shipped service object. */
  call(name, args = [], transfer = []) {
    return this.send({ type: "method", name, args }, transfer);
  }
  /** Subscribe to worker-emitted stream events; returns unsubscribe. */
  onEvent(handler) {
    this.eventHandlers.push(handler);
    return () => {
      const i = this.eventHandlers.indexOf(handler);
      if (i >= 0) this.eventHandlers.splice(i, 1);
    };
  }
  send(body, transfer) {
    const id = `m${this.seq++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...body }, transfer);
    });
  }
  get pendingCount() {
    return this.pending.size;
  }
  terminate() {
    this.failAll(new Error("Task terminated"));
    return this.worker.terminate();
  }
};
async function runInThread(fn, ...args) {
  const task = await Task.spawn(fn);
  try {
    return await task.run(args);
  } finally {
    await task.terminate();
  }
}

// src/pool.ts
var WorkerPool = class _WorkerPool {
  constructor(fn, size) {
    this.fn = fn;
    this.size = size;
  }
  fn;
  size;
  idle = [];
  all = [];
  queue = [];
  spawning = 0;
  closed = false;
  static async create(fn, size) {
    const n = size ?? await hardwareConcurrency();
    return new _WorkerPool(fn, Math.max(1, n));
  }
  /** Enqueue one invocation; resolves when a thread has produced the result. */
  exec(args, transfer = []) {
    if (this.closed) return Promise.reject(new Error("Pool closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ args, transfer, resolve, reject });
      this.pump();
    });
  }
  /** Parallel map with pool-bounded concurrency, order preserved. */
  map(items, toArgs) {
    return Promise.all(items.map((item, i) => this.exec(toArgs(item, i))));
  }
  pump() {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const job = this.queue.shift();
      const task = this.idle.pop();
      task.run(job.args, job.transfer).then(job.resolve, job.reject).finally(() => {
        if (!this.closed) {
          this.idle.push(task);
          this.pump();
        }
      });
    }
    if (this.queue.length > 0 && this.all.length + this.spawning < this.size) {
      this.spawning++;
      Task.spawn(this.fn).then((task) => {
        this.spawning--;
        if (this.closed) return void task.terminate();
        this.all.push(task);
        this.idle.push(task);
        this.pump();
      }).catch((err) => {
        this.spawning--;
        if (this.all.length === 0) {
          const q = this.queue.splice(0);
          for (const job of q) job.reject(err);
        }
      });
    }
  }
  /** Threads actually started (grows lazily up to `size`). */
  get started() {
    return this.all.length;
  }
  async close() {
    this.closed = true;
    const q = this.queue.splice(0);
    for (const job of q) job.reject(new Error("Pool closed"));
    await Promise.all(this.all.map((t) => t.terminate()));
    this.all = [];
    this.idle = [];
  }
};

// src/shared.ts
function assertShared() {
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error(
      "SharedArrayBuffer unavailable. In browsers this requires cross-origin isolation (COOP/COEP)."
    );
  }
}
var SharedCounter = class {
  buffer;
  view;
  constructor(bufferOrInitial = 0) {
    if (bufferOrInitial instanceof SharedArrayBuffer) {
      this.buffer = bufferOrInitial;
    } else {
      assertShared();
      this.buffer = new SharedArrayBuffer(4);
      new Int32Array(this.buffer)[0] = bufferOrInitial;
    }
    this.view = new Int32Array(this.buffer);
  }
  add(n = 1) {
    return Atomics.add(this.view, 0, n) + n;
  }
  get value() {
    return Atomics.load(this.view, 0);
  }
};
var Mutex = class _Mutex {
  static UNLOCKED = 0;
  static LOCKED = 1;
  buffer;
  view;
  constructor(buffer) {
    if (buffer) {
      this.buffer = buffer;
    } else {
      assertShared();
      this.buffer = new SharedArrayBuffer(4);
    }
    this.view = new Int32Array(this.buffer);
  }
  /** Blocking acquire. */
  lock() {
    for (; ; ) {
      if (Atomics.compareExchange(this.view, 0, _Mutex.UNLOCKED, _Mutex.LOCKED) === _Mutex.UNLOCKED)
        return;
      Atomics.wait(this.view, 0, _Mutex.LOCKED);
    }
  }
  /** Non-blocking acquire; true on success. */
  tryLock() {
    return Atomics.compareExchange(this.view, 0, _Mutex.UNLOCKED, _Mutex.LOCKED) === _Mutex.UNLOCKED;
  }
  /** Async acquire — safe on the browser main thread (Atomics.waitAsync). */
  async lockAsync() {
    for (; ; ) {
      if (this.tryLock()) return;
      const w = Atomics.waitAsync?.(this.view, 0, _Mutex.LOCKED);
      if (w?.async) await w.value;
      else await new Promise((r) => setTimeout(r, 0));
    }
  }
  unlock() {
    Atomics.store(this.view, 0, _Mutex.UNLOCKED);
    Atomics.notify(this.view, 0, 1);
  }
  /** Run `fn` under the lock (blocking variant). */
  withLock(fn) {
    this.lock();
    try {
      return fn();
    } finally {
      this.unlock();
    }
  }
};
var Signal = class {
  buffer;
  view;
  constructor(buffer) {
    if (buffer) {
      this.buffer = buffer;
    } else {
      assertShared();
      this.buffer = new SharedArrayBuffer(4);
    }
    this.view = new Int32Array(this.buffer);
  }
  /** Blocking wait (Node / browser worker). Returns false on timeout. */
  wait(timeoutMs = Infinity) {
    if (Atomics.load(this.view, 0) !== 0) return true;
    return Atomics.wait(this.view, 0, 0, timeoutMs) !== "timed-out";
  }
  /** Async wait — safe everywhere. */
  async waitAsync(timeoutMs = Infinity) {
    if (Atomics.load(this.view, 0) !== 0) return true;
    const w = Atomics.waitAsync?.(this.view, 0, 0, timeoutMs);
    if (w?.async) return await w.value !== "timed-out";
    if (w) return w.value !== "timed-out";
    const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 2 ** 31);
    while (Date.now() < deadline) {
      if (Atomics.load(this.view, 0) !== 0) return true;
      await new Promise((r) => setTimeout(r, 1));
    }
    return false;
  }
  fire() {
    Atomics.store(this.view, 0, 1);
    Atomics.notify(this.view, 0);
  }
};

// src/proxy.ts
function wrap(task) {
  return new Proxy(/* @__PURE__ */ Object.create(null), {
    get(_t, prop) {
      if (typeof prop === "symbol") return void 0;
      if (prop === "then") return void 0;
      if (prop === "terminate") return () => task.terminate();
      return (...args) => task.call(prop, args);
    }
  });
}
async function spawnRemote(methods) {
  return wrap(await Task.spawnService(methods));
}
export {
  Mutex,
  SharedCounter,
  Signal,
  Task,
  UnifiedWorker,
  WorkerPool,
  _bootstrap,
  hardwareConcurrency,
  hasSharedMemory,
  isNode,
  runInThread,
  spawnRemote,
  wrap
};
