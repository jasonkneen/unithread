# unithread API reference

Source of truth for signatures: `src/index.ts` (the export list) and the individual modules it
re-exports from (`spawn.ts`, `pool.ts`, `proxy.ts`, `shared.ts`, `runtime.ts`), and `README.md` for
usage framing. This file mirrors those, verified runnable against the vendored
`skill/assets/unithread.bundle.js`. If it ever disagrees with `src/index.ts`, the source wins.

Every snippet below assumes this import and has been run against `skill/assets/unithread.bundle.js`
(Node, ESM) to confirm it works as shown:

```js
import { runInThread, Task, WorkerPool, SharedCounter, Mutex, Signal, spawnRemote, wrap,
         isNode, hardwareConcurrency, hasSharedMemory } from "./unithread.bundle.js";
```

## The one rule

Every shipped function crosses the thread boundary via `Function.prototype.toString()`. It must
be **self-contained** — no references to variables from an enclosing scope. Everything it needs
arrives as an argument (or via `SharedArrayBuffer`). The last argument injected into every shipped
function is a `WorkerEnv` (documented at the bottom) — do not declare a parameter for it unless
you use it.

## `runInThread(fn, ...args)`

One-shot: spawns a thread, runs `fn` once with `args`, terminates, resolves with the result.

```js
const n = await runInThread((x) => {
  const fib = (i) => (i < 2 ? i : fib(i - 1) + fib(i - 2));
  return fib(x);
}, 10);
// n === 55
```

## `Task` — a persistent thread you call repeatedly

### `Task.spawn(fn)`

```js
const task = await Task.spawn((a, b) => a + b);
await task.run([2, 3]);        // 5
await task.terminate();
```

### `task.run(args, transfer?)`

Invokes the shipped function. `args` is an array; `transfer` is an optional list of
`ArrayBuffer`/`MessagePort` to move (not copy) into the worker.

```js
const task = await Task.spawn((buf) => new Uint8Array(buf).length);
const buf = new ArrayBuffer(1024);
await task.run([buf], [buf]);  // buf is moved, not copied — `buf.byteLength` is now 0
await task.terminate();
```

### `task.call(name, args?, transfer?)`

Invokes one named method of a service task (see `Task.spawnService` below).

```js
const svc = await Task.spawnService({ square: (x) => x * x });
await svc.call("square", [12]);  // 144
await svc.terminate();
```

### `task.onEvent(handler)`

Subscribes to fire-and-forget events streamed from the worker via `env.emit(...)`. Returns an
unsubscribe function.

```js
const task = await Task.spawn((n, env) => {
  env.emit("progress", { n });
  return n * 2;
});
const off = task.onEvent((event, data) => console.log(event, data)); // "progress" { n: 21 }
await task.run([21]);
off();
await task.terminate();
```

### `task.terminate()`

Kills the worker and rejects any in-flight calls. Always call this when a `Task` is no longer
needed — `runInThread` does it for you; `Task.spawn`/`spawnService`/`WorkerPool` do not.

### `Task.spawnService(methods)`

Ships an **object of named functions** as one worker; call individual methods with `task.call` or
wrap the whole thing with `wrap()`/`spawnRemote()` below. Each method must independently be
self-contained.

```js
const svc = await Task.spawnService({
  square: (x) => x * x,
  cube: (x) => x * x * x,
});
await svc.call("square", [12]); // 144
await svc.terminate();
```

## `spawnRemote(methods)` / `wrap(task)`

Comlink-style proxy over a service task: `remote.method(args)` instead of
`task.call("method", [args])`. `spawnRemote` spawns and wraps in one step; `wrap` wraps an
already-spawned service `Task`. Both proxies expose `.terminate()`.

```js
const remote = await spawnRemote({ square: (x) => x * x });
await remote.square(12); // 144
await remote.terminate();
```

```js
const task = await Task.spawnService({ cube: (x) => x * x * x });
const remote = wrap(task);
await remote.cube(3); // 27
await remote.terminate(); // terminates the underlying task
```

## `WorkerPool` — parallel over a fixed set of threads

### `WorkerPool.create(fn, size?)`

`size` defaults to detected hardware concurrency. **Measured default for CPU pools: `min(4, cores
- 1)`** — an 8-worker pool scored worse than 4 (oversubscription). Pass `size` explicitly to use
that default rather than raw core count.

```js
const pool = await WorkerPool.create((n) => n * 2, 2);
await pool.close();
```

### `pool.exec(args, transfer?)`

Enqueues one call; resolves when a thread has produced the result. FIFO queue, workers spawn
lazily up to `size` as demand appears.

```js
const pool = await WorkerPool.create((n) => n * 2, 2);
await pool.exec([21]); // 42
await pool.close();
```

### `pool.map(items, toArgs)`

Parallel map, pool-bounded concurrency, **order preserved** in the returned array.

```js
const pool = await WorkerPool.create((n) => n * 2, 2);
const results = await pool.map([1, 2, 3], (n) => [n]); // [2, 4, 6]
await pool.close();
```

### `pool.close()`

Rejects anything still queued, terminates every worker the pool actually started. Always call
this when done with a pool.

```js
const pool = await WorkerPool.create((n) => n * 2, 2);
const one = await pool.exec([21]);
const many = await pool.map([1, 2, 3], (n) => [n]);
await pool.close();
```

## Shared memory — `SharedCounter`, `Mutex`, `Signal`

These are the **only** true shared state across JS threads (backed by `SharedArrayBuffer` +
`Atomics`); everything else crossing the boundary is copied via structured clone.

**Browser note:** `SharedArrayBuffer` requires cross-origin isolation (COOP/COEP response
headers) — that's a server change, not a code change; see `demo/serve.mjs` in this repo for a
30-line reference server. **`Atomics.wait` is forbidden on the browser main thread.** Use
`lockAsync()` / `waitAsync()` there instead of the blocking `lock()` / `wait()`. Node has no such
restriction — blocking calls are fine on any Node thread, including the main one.

### `SharedCounter`

Lock-free atomic counter.

```js
const counter = new SharedCounter(0);
await runInThread((buf) => {
  const view = new Int32Array(buf);
  Atomics.add(view, 0, 5);
}, counter.buffer);
counter.value; // 5
```

### `Mutex` — `lock` / `tryLock` / `lockAsync` / `unlock` / `withLock`

```js
const mutex = new Mutex();

// Blocking (Node anywhere; browser workers only — never the browser main thread):
mutex.withLock(() => { /* critical section */ });

// Async, safe everywhere including the browser main thread:
await mutex.lockAsync();
try { /* critical section */ } finally { mutex.unlock(); }
```

### `Signal` — `wait` / `waitAsync` / `fire`

One-shot cross-thread signal: one side waits, another fires.

```js
const signal = new Signal();
signal.fire();
await signal.waitAsync(100); // true — already fired, resolves immediately
```

`wait(timeoutMs?)` is the blocking counterpart (same main-thread restriction as `Mutex.lock`).

## Runtime helpers

```js
isNode                          // boolean — Node vs. browser, detected once at import time
await hardwareConcurrency()     // number — available OS threads (os.availableParallelism() in
                                 // Node, navigator.hardwareConcurrency in the browser)
hasSharedMemory()                // boolean — SharedArrayBuffer usable right now (false in a
                                 // browser without COOP/COEP)
```

## `WorkerEnv` — the injected last argument

Every function shipped via `runInThread`, `Task.spawn`, **or `WorkerPool.create`** receives one
extra argument after the ones you pass: a `WorkerEnv`. Pool functions are not special here — the
pool ships them through `Task.spawn` and the same "call" protocol, so `(n, env) => …` works in a
pool exactly as it does in a task.

**`Task.spawnService` methods are the one exception** — they are invoked as plain methods
(`task.call(name, args)`) with no env appended, so reach for `globalThis.__unithread` inside a
service method instead (see the note under `env.emit` below).

```ts
interface WorkerEnv {
  isMainThread: boolean;
  threadId: number;
  runtime: "node" | "web";
  emit(event: string, data?: any, transfer?: (ArrayBuffer | MessagePort)[]): void;
  transfer<T>(value: T, list: (ArrayBuffer | MessagePort)[]): T;
}
```

```js
const info = await runInThread((_x, env) => ({
  isMainThread: env.isMainThread,   // false — this code is running on the worker side
  threadId: env.threadId,           // Node: real worker thread id. Browser: always -1.
  runtime: env.runtime,             // "node" or "web"
}), 1);
```

- `env.emit(event, data, transfer?)` — stream a fire-and-forget event to the main thread; read it
  with `task.onEvent(...)`. Also reachable as `globalThis.__unithread.emit` inside a
  `spawnService` method body, since those aren't given a plain trailing parameter.
- `env.transfer(value, list)` — wrap a return value so the buffers in `list` are moved back to the
  main thread instead of copied. Pair it with the `transfer` list on `task.run`/`pool.exec` for
  zero-copy in both directions:

```js
const task = await Task.spawn((buf, env) => {
  new Uint8Array(buf)[0] = 42;
  return env.transfer(buf, [buf]);
});
const input = new ArrayBuffer(8);
const out = await task.run([input], [input]); // input moved in, out moved back
new Uint8Array(out)[0]; // 42
await task.terminate();
```
