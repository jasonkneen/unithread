// Proof harness for unithread. Each test asserts the SPECIFIC claim:
// not "it ran", but "this is a real independent thread with shared memory".
import { threadId as mainThreadId } from "node:worker_threads";
import {
  Task,
  runInThread,
  WorkerPool,
  SharedCounter,
  Mutex,
  Signal,
  isNode,
  hardwareConcurrency,
} from "../dist/index.js";

let pass = 0, fail = 0;
function assert(name, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
  else      { fail++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

// ── 1. Identity: the shipped function runs OFF the main thread ─────────────
{
  const env = await runInThread((env) => env);
  assert("worker is not main thread", env.isMainThread === false, `env=${JSON.stringify(env)}`);
  assert("worker threadId differs from main", env.threadId !== mainThreadId,
    `worker=${env.threadId} main=${mainThreadId}`);
}

// ── 2. Liveness: main event loop keeps ticking while worker busy-spins ─────
// Impossible without a genuinely independent thread: a 400ms synchronous
// spin on the main thread would freeze all timers.
{
  let ticks = 0;
  const iv = setInterval(() => ticks++, 10);
  await runInThread((ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {} // hard synchronous spin
    return true;
  }, 400);
  clearInterval(iv);
  assert("main thread stayed responsive during worker CPU-burn", ticks >= 10, `${ticks} ticks during 400ms burn`);
}

// ── 3. Deadlock-impossible proof: main BLOCKS on Atomics.wait, worker fires ─
// If the "worker" secretly shared the main thread, this must deadlock.
// A 3s timeout converts deadlock into an honest FAIL instead of a hang.
{
  const sig = new Signal();
  const task = await Task.spawn((buf, delayMs) => {
    const view = new Int32Array(buf);
    const end = Date.now() + delayMs;
    while (Date.now() < end) {}
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0);
    return true;
  });
  const p = task.run([sig.buffer, 100]);
  const woke = sig.wait(3000); // BLOCKING wait on the main thread
  await p; await task.terminate();
  assert("blocking Atomics.wait released by worker (true OS thread)", woke === true);
}

// ── 4. Shared memory: N workers hammer one SharedArrayBuffer atomically ────
{
  const N = 4, PER = 50_000;
  const counter = new SharedCounter(0);
  const tasks = await Promise.all(Array.from({ length: N }, () =>
    Task.spawn((buf, iterations) => {
      const view = new Int32Array(buf);
      for (let i = 0; i < iterations; i++) Atomics.add(view, 0, 1);
      return true;
    })
  ));
  await Promise.all(tasks.map((t) => t.run([counter.buffer, PER])));
  await Promise.all(tasks.map((t) => t.terminate()));
  assert("atomic counter exact across 4 threads", counter.value === N * PER,
    `${counter.value} === ${N * PER}`);
}

// ── 5. Mutex: read-modify-write under lock stays exact ─────────────────────
{
  const N = 4, PER = 2_000;
  const mutex = new Mutex();
  const data = new SharedArrayBuffer(4);
  const tasks = await Promise.all(Array.from({ length: N }, () =>
    Task.spawn((lockBuf, dataBuf, iterations) => {
      const lock = new Int32Array(lockBuf);
      const view = new Int32Array(dataBuf);
      for (let i = 0; i < iterations; i++) {
        // inline blocking mutex (no closure imports cross the thread boundary)
        for (;;) {
          if (Atomics.compareExchange(lock, 0, 0, 1) === 0) break;
          Atomics.wait(lock, 0, 1);
        }
        const v = view[0];        // deliberately NON-atomic RMW…
        view[0] = v + 1;          // …safe only because the mutex serializes it
        Atomics.store(lock, 0, 0);
        Atomics.notify(lock, 0, 1);
      }
      return true;
    })
  ));
  await Promise.all(tasks.map((t) => t.run([mutex.buffer, data, PER])));
  await Promise.all(tasks.map((t) => t.terminate()));
  const total = new Int32Array(data)[0];
  assert("mutex-guarded non-atomic RMW exact across 4 threads", total === N * PER,
    `${total} === ${N * PER}`);
}

// ── 6. Pool: bounded threads, order-preserving map, correct results ────────
{
  const pool = await WorkerPool.create((n) => {
    // CPU-bound: naive fibonacci
    const fib = (x) => (x < 2 ? x : fib(x - 1) + fib(x - 2));
    return fib(n);
  }, 3);
  const inputs = [20, 21, 22, 23, 24, 25, 26, 27];
  const results = await pool.map(inputs, (n) => [n]);
  const expected = [6765, 10946, 17711, 28657, 46368, 75025, 121393, 196418];
  assert("pool.map results correct & ordered",
    JSON.stringify(results) === JSON.stringify(expected), JSON.stringify(results));
  assert("pool bounded to size", pool.started <= 3, `started=${pool.started} size=${pool.size}`);
  await pool.close();
}

// ── 7. RPC: ship an object of methods, call by name ────────────────────────
{
  const mathSvc = await Task.spawnService({
    square: (x) => x * x,
    sum: (...xs) => xs.reduce((a, b) => a + b, 0),
    boom: () => { throw new Error("kaboom"); },
  });
  const sq = await mathSvc.call("square", [12]);
  const sm = await mathSvc.call("sum", [1, 2, 3, 4]);
  let errMsg = "";
  try { await mathSvc.call("boom"); } catch (e) { errMsg = e.message; }
  await mathSvc.terminate();
  assert("rpc method square", sq === 144, String(sq));
  assert("rpc method variadic sum", sm === 10, String(sm));
  assert("worker error propagates with message", errMsg === "kaboom", errMsg);
}

// ── 8. Async worker functions resolve properly ─────────────────────────────
{
  const v = await runInThread(async (a, b) => {
    await new Promise((r) => setTimeout(r, 20));
    return a * b;
  }, 6, 7);
  assert("async shipped function", v === 42, String(v));
}

// ═══ v0.2 drop-in additions ═════════════════════════════════════════════════
import { wrap, spawnRemote, _bootstrap } from "../dist/index.js";
import vm from "node:vm";

// ── 9. Proxy: natural method calls via wrap/spawnRemote ────────────────────
{
  const svc = await spawnRemote({
    pow: (a, b) => Math.pow(a, b),
    upper: (s) => s.toUpperCase(),
  });
  const [p, u] = await Promise.all([svc.pow(2, 10), svc.upper("drop-in")]);
  await svc.terminate();
  assert("proxy method pow", p === 1024, String(p));
  assert("proxy method upper", u === "DROP-IN", u);
}

// ── 10. Transferables OUT: buffer is moved (detached), not copied ──────────
{
  const task = await Task.spawn((buf) => new Uint8Array(buf).byteLength);
  const buf = new ArrayBuffer(4096);
  const seen = await task.run([buf], [buf]);
  await task.terminate();
  assert("worker received transferred buffer", seen === 4096, `worker saw ${seen} bytes`);
  assert("source buffer detached after transfer (moved, not copied)",
    buf.byteLength === 0, `byteLength=${buf.byteLength}`);
}

// ── 11. Transferables BACK: worker returns a moved buffer via env.transfer ─
{
  const task = await Task.spawn((size, env) => {
    const out = new ArrayBuffer(size);
    new Uint8Array(out).fill(7);
    return env.transfer(out, [out]);
  });
  const returned = await task.run([2048]);
  await task.terminate();
  const ok = returned instanceof ArrayBuffer &&
             returned.byteLength === 2048 &&
             new Uint8Array(returned)[100] === 7;
  assert("worker returned transferred buffer intact", ok,
    `byteLength=${returned?.byteLength}`);
}

// ── 12. Streaming: worker emits progress events during one call ────────────
{
  const task = await Task.spawn((steps, env) => {
    for (let i = 1; i <= steps; i++) env.emit("progress", { step: i, of: steps });
    return "done";
  });
  const events = [];
  task.onEvent((event, data) => events.push([event, data.step]));
  const result = await task.run([5]);
  await task.terminate();
  assert("streamed 5 progress events in order",
    events.length === 5 && events.every(([e, s], i) => e === "progress" && s === i + 1),
    JSON.stringify(events));
  assert("call still resolved after streaming", result === "done", result);
}

// ── 13. Browser-branch simulation: bootstrap under a mock `self` in vm ─────
// Proves the SAME bootstrap takes the web path and speaks the protocol when
// `self` exists and `require` does not (the container has no real browser).
{
  const posted = [];
  const ctx = vm.createContext({});
  vm.runInContext("globalThis.self = globalThis;", ctx);
  ctx.postMessage = (m) => posted.push(m);
  vm.runInContext(_bootstrap("(x) => x * 3"), ctx);
  const ready = posted.find((m) => m.id === "__ready__");
  ctx.onmessage({ data: { id: "b1", type: "call", args: [7] } });
  await new Promise((r) => setTimeout(r, 20)); // let vm microtasks flush
  const replied = posted.find((m) => m.id === "b1");
  assert("bootstrap web branch: ready handshake", ready?.value?.runtime === "web",
    JSON.stringify(ready?.value));
  assert("bootstrap web branch: call protocol round-trip",
    replied?.ok === true && replied?.value === 21, JSON.stringify(replied));
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log(`\nruntime=node isNode=${isNode} cores=${await hardwareConcurrency()} mainThreadId=${mainThreadId}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("VERDICT: FAIL"); process.exit(1); }
console.log("VERDICT: PASS");

