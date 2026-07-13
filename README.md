# unithread

True multithreading for JavaScript with **one API across Node and the browser**. Wraps `node:worker_threads` and Web Workers behind a single surface: function shipping, worker pools, RPC services, and shared memory via `SharedArrayBuffer` + `Atomics`.

```js
import { runInThread, Task, WorkerPool, SharedCounter, Mutex, Signal } from "unithread";

// One-shot: run a function on a real OS thread
const n = await runInThread((x) => {
  const fib = (i) => (i < 2 ? i : fib(i - 1) + fib(i - 2));
  return fib(x);
}, 35);

// Persistent thread, call repeatedly
const task = await Task.spawn((a, b) => a + b);
await task.run([2, 3]); // 5
await task.terminate();

// RPC service: object of named methods on one thread
const svc = await Task.spawnService({
  square: (x) => x * x,
  hash: (s) => { /* self-contained work */ },
});
await svc.call("square", [12]); // 144

// Pool sized to hardware cores, order-preserving parallel map
const pool = await WorkerPool.create((n) => heavyWork(n));
const results = await pool.map(inputs, (n) => [n]);
await pool.close();

// True shared memory across threads
const counter = new SharedCounter(0);       // Atomics-backed
const mutex   = new Mutex();                // lock() / lockAsync() / withLock()
const signal  = new Signal();               // wait() / waitAsync() / fire()
await runInThread((buf) => {
  new Int32Array(buf); Atomics.add(new Int32Array(buf), 0, 1);
}, counter.buffer);
```

## How it works
- **Node**: `new Worker(source, { eval: true })` from `node:worker_threads`.
- **Browser**: `new Worker(URL.createObjectURL(new Blob([source])))`.
- One env-detecting bootstrap script runs in both worker types and speaks a small id-correlated message protocol (call / method / result / error), so `Task`, `WorkerPool`, and RPC behave identically in either runtime.

## Rules & caveats (the honest ones)
- **Shipped functions must be self-contained.** They cross the thread boundary via `Function.prototype.toString()` — no closure captures, no imports from outer scope. Pass data as arguments; use `SharedArrayBuffer` for shared state.
- **Browser `SharedArrayBuffer` requires cross-origin isolation** (COOP/COEP headers). `Atomics.wait` is forbidden on the browser main thread — use `lockAsync()` / `waitAsync()` there. Node has no such restriction.
- **Everything non-shared is copied** (structured clone). Pass `ArrayBuffer`s in the `transfer` list to move instead of copy.
- Last arg injected into shipped functions is a `WorkerEnv` (`{ isMainThread, threadId, runtime }`).

## Drop-in usage

**Node / bundlers** — `npm install`, then `import { ... } from "unithread"`.

**Browser, zero build step** — copy `dist/unithread.bundle.min.js` (8 kB) next to your page:
```html
<script type="module">
  import { runInThread, WorkerPool, spawnRemote } from "./unithread.bundle.min.js";
  const svc = await spawnRemote({ square: (x) => x * x });
  console.log(await svc.square(12)); // 144 — computed on a real thread
  await svc.terminate();
</script>
```
For `SharedArrayBuffer` in the browser, serve with COOP/COEP (see `demo/serve.mjs` for a 30-line reference server):
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
Everything except shared memory (spawn, pools, RPC proxies, transfers) works without those headers.

## Verified (this build)

**Node 24 — 21/21** (`npm test`) and **real Chromium via Playwright — 11/11** (`npm run test:browser`), including the proofs that are impossible without independent OS threads:
- main thread timers kept firing (~42 ticks) during a 400 ms synchronous worker spin — both runtimes
- Node main thread **blocked** on `Atomics.wait`, released by a worker's `notify`; browser main thread same via `waitAsync`
- 4 threads × 50 k atomic increments = exactly 200 000 on one `SharedArrayBuffer` — both runtimes
- mutex-serialized non-atomic read-modify-write exact across 4 threads — both runtimes
- zero-copy `ArrayBuffer` transfer worker→main — both runtimes
- browser suite ran cross-origin-isolated (`crossOriginIsolated === true`)


## Drop-in options
1. **npm tarball**: `npm i ./unithread-0.2.0.tgz` — full package with types.
2. **Single file**: copy `dist/unithread.bundle.js` (13 kB, zero deps) or `.min.js` (8 kB) into your project; `import { ... } from "./unithread.bundle.js"` works in Node and browsers unchanged.
3. **Browser check**: `npm run demo` → <http://localhost:8080>. Serves with COOP/COEP already set, so the `SharedArrayBuffer` proofs run rather than skip.

## v0.2 additions
- `spawnRemote(methods)` / `wrap(task)` — Comlink-style proxy: `await svc.pow(2, 10)`.
- Transferables both directions: pass a transfer list to `run`/`call`; return via `env.transfer(value, [buffers])`. Moved, not copied — source detaches.
- Streaming: worker calls `env.emit(event, data)` mid-task; main thread subscribes with `task.onEvent(cb)`. Also on `globalThis.__unithread` inside service methods.

## Build / test / demo
```
npm install && npm run build   # tsc -> dist/, then esbuild -> dist/unithread.bundle[.min].js
npm test                       # node suite      — 21/21
npm run test:browser           # chromium suite  — 11/11 (needs: npx playwright install chromium)
npm run demo                   # http://localhost:8080, served with COOP/COEP
```

`npm run demo` opens a live page with one switch on it. The same workload (`fib(34)` on a
loop, ~110 ms a job) runs non-stop; the switch moves it between the main thread and a pool of
worker threads, and a frame-time trace shows the result immediately:

| work runs on | fps | worst frame | jobs/sec |
| --- | --- | --- | --- |
| main thread | ~16 | ~133 ms | 7 |
| 4 worker threads | ~59 | ~18 ms | 13 |

Measured on a 16-core M-series in Chromium. The frame trace goes from a solid wall of red
(every frame missing the 16.7 ms budget) to solid green the instant you flip it.
