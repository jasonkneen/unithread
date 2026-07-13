---
name: unithread
description: Move CPU-bound work off the main thread onto real OS threads (Web Workers / node:worker_threads) via unithread. Use when a UI is janky or frozen, a page locks up, an event loop is blocked, "this loop is too slow", or the user asks to parallelise a loop, use worker threads, offload work, or make something stop blocking.
---

# unithread — offload CPU work onto real threads

Audit a codebase for main-thread hogs, move them onto real OS threads, and prove they moved.
One API works in both Node and browsers.

## The rule that breaks everything

Shipped functions cross the thread boundary via `Function.prototype.toString()`. **Anything they
captured from an enclosing scope does not exist on the other side.** It typechecks. It lints. It
passes review. Best case it throws `ReferenceError` at runtime inside the worker. Worst case a
`typeof` guard swallows the missing identifier and it **silently returns a wrong answer** instead:

```js
const MULTIPLIER = 3;
runInThread((n) => n * MULTIPLIER, 5);   // ReferenceError: MULTIPLIER is not defined

const MULT = 7;
runInThread((n) => (typeof MULT !== "undefined" ? n * MULT : n), 5);
// no error — silently returns 5 instead of 35, because MULT doesn't exist in the worker

runInThread((n, m) => n * m, 5, 3);      // correct — everything arrives as an argument
```

Data crosses as arguments, transferables, or `SharedArrayBuffer`. Nothing else. This is why Gate 1
below does not just ask "did it throw?" — see Phase 4.

## Workflow

### 1. Audit — measure, never guess

Find CPU-bound **synchronous** work: pixel/matrix loops, parse or serialise of large payloads,
hashing, compression, recursive search. Then time the candidates on representative input:

    node <skill>/scripts/measure.mjs path/to/mod.mjs#exportName '[args]'

**Do not offload anything under ~16 ms.** The round-trip plus structured clone costs more than
the work. Present the ranked candidates with their measured costs and let the user choose.

Workers are for **CPU**, not I/O. Async I/O already yields; a thread buys nothing.

### 2. Baseline — on a quiet machine

Record the metric before changing anything.

- **Node**: `measure.mjs` reports `wallMs` and `worstBlockMs` (the main-thread block, in ms), and
  it also prints the idle event-loop noise floor **before and after** the run. If either floor is
  over 20 ms it **refuses to run** (non-zero exit) rather than hand back a number — a busy machine
  produces confident, wrong conclusions. Close other work and re-run. Residual limitation, stated
  honestly: a burst of contention that starts and fully subsides *inside* the run window, gone
  before the after-check samples, is invisible to both floors — this gate catches contention
  present immediately before or after the run, not one confined entirely inside it.

      node <skill>/scripts/measure.mjs path/to/mod.mjs#exportName '[args]'

- **Browser**: `--browser <url> --action "<js>" --seconds N`. Leads with `worstFrameMs` and
  `jankFrames` (count and % of frames over the 16.7 ms budget) — those are the honest gate.
  `fps` is printed last for reference only: headless Chromium is **not vsync-capped**, a smooth
  run can read ~120 fps, and it must never be compared against 60.

      node <skill>/scripts/measure.mjs --browser http://localhost:8080/ --action "startWork()" --seconds 4

  Worked example, this repo's own demo, same workload, only the thread it runs on changes:

      main thread        worst frame  92-133 ms   jank frames  98.9%
      4-worker pool      worst frame   9-18 ms    jank frames  0%

### 3. Offload

1. Copy `<skill>/assets/unithread.bundle.js` into the project (e.g. `src/lib/unithread.js`).
   Zero deps, 13 kB, same file works in Node and browsers.
2. Rewrite the hot function to be self-contained — every captured value becomes a parameter.
3. Pick the primitive:
   - `runInThread(fn, ...args)` — one-shot.
   - `Task.spawn(fn)` — persistent, called repeatedly.
   - `WorkerPool.create(fn, size)` + `pool.map(items, toArgs)` — parallel over a collection.
   - `spawnRemote(methods)` — an object of methods as a service proxy.
4. Big buffers go in the transfer list — moved, not copied (the source detaches).
5. `SharedArrayBuffer` only when state is genuinely shared. In browsers it needs COOP/COEP
   headers, which is a server change, not a code change.

**Defaults, measured — do not invent your own:**
- Pool size `min(4, cores - 1)`. A pool of 8 scored *worse* than 4 (2.0x vs 2.94x) — oversubscription.
- Keep 2 jobs in flight per worker. At depth 1 each worker idles through the result
  round-trip (8.4 vs 12.4 jobs/sec).

### 4. Prove — both gates, no exceptions

**Gate 1 — portability.** Runs the candidate on **both** the main thread and in a real worker,
with the same args, and deep-compares the two results — it does not merely ask "did it throw?":

    node <skill>/scripts/verify-portable.mjs path/to/mod.mjs#exportName '[args]'

The result carries a `reason`:
- `captured` — a real `ReferenceError`; the leaked identifier is named in the output.
- `diverged` — no error, but the two sides computed **different answers**. This is the case a
  throw-only check would miss entirely: `typeof MULT !== "undefined" ? n * MULT : n` doesn't
  throw in the worker, it just silently takes the other branch and returns the wrong number.
- `threw` — the candidate raised its own error (not a leaked identifier); that's the candidate's
  business, not a boundary problem.

Fails with `captured` or `diverged` → fix the identified capture, pass it as an argument, re-run.

Consequences, stated honestly:
- **The candidate runs twice** (once per side). A function with side effects — writes a file,
  increments an external counter, sends a request, mutates a shared object — pays for both runs.
  Know what you're passing in before running this on anything but a pure function.
- **A non-deterministic function** (`Math.random()`, `Date.now()`) will legitimately compute two
  different results and get reported as `diverged` even though it's perfectly portable. That's a
  false alarm, not a bug in the candidate. Use `--no-compare` for these — it drops back to the
  "did it throw?" check and the candidate runs once, in the worker only.
- **Residual limitation:** the gate only exercises the code path your sample args take. A capture
  on a branch the args never reach can still slip through. Sample args must exercise the path
  under test.

**Gate 2 — improvement.** Re-measure the Phase 2 metric with the same command and report **both**
numbers, before and after:

    BEFORE  worst frame 133 ms / jank 98.9%
    AFTER   worst frame  18 ms / jank 0%

**If the number did not move, say so and revert.** "It compiles", "no errors", and "tests pass"
are not evidence: no test suite notices jank. A no-op offload is never reported as a win.

## API

See `references/api.md` for the full surface and the browser/Node differences.
