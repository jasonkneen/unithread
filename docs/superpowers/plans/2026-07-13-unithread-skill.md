# unithread Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package unithread as a portable Claude Code skill that audits an existing codebase for main-thread hogs, offloads them to real OS threads, and refuses to claim success without a measured before/after.

**Architecture:** A `skill/` directory in this repo, installed by symlink to `~/.claude/skills/unithread/`. It carries the library as a vendored single-file bundle (synced from `dist/` so it cannot drift), a knowledge file (`SKILL.md`), an API reference, and two executable gates: `verify-portable.mjs` (does the function survive the thread boundary?) and `measure.mjs` (did the main thread actually get freed?).

**Tech Stack:** Node ≥ 22, ESM, zero runtime dependencies. Playwright is used only by `measure.mjs --browser` and is optional — the script degrades with a clear message if it is absent.

## Global Constraints

- **ESM only.** Repo is `"type": "module"`. No `require()` in skill scripts.
- **Zero runtime deps in the skill.** Only Node builtins plus the vendored bundle. Playwright is optional and dynamically imported.
- **Match repo style:** 2-space indent, semicolons, double quotes. (The repo uses semicolons; follow it, not the global no-semicolon preference.)
- **Shipped functions must be self-contained.** They cross the boundary via `Function.prototype.toString()`. No closure captures, no outer-scope imports.
- **Measured defaults, copied verbatim from the spec:** pool size `min(4, cores - 1)`; queue depth 2 jobs in flight per worker; do not offload work under **~16 ms**.
- **A stall is observed late.** After a main-thread block ends, the delayed timer/frame callback carrying the real delta fires *after* the block, and in browsers the first frame after a stall reports a stale timestamp. Any measurement MUST settle extra ticks/frames before it stops sampling. This is the bug that made this repo's demo report an 8 ms stall during a 1.2 s freeze.
- **Tests use `node:test` + `node:assert/strict`** (built in, zero-dep). Run with `node --test`.

---

### Task 1: Skill scaffold + vendored bundle sync

The bundle must be a copy of `dist/unithread.bundle.js`, produced by a script, so it can never drift from the library source.

**Files:**
- Create: `skill/assets/.gitkeep`
- Create: `scripts/sync-skill-asset.mjs`
- Create: `skill/test/asset.test.mjs`
- Modify: `package.json` (scripts block)
- Modify: `.gitignore` (un-ignore the vendored asset — `dist/` is ignored, the asset is not)

**Interfaces:**
- Produces: `skill/assets/unithread.bundle.js` — the vendored ESM bundle every other task imports.
- Produces: npm script `skill:sync`.

- [ ] **Step 1: Write the failing test**

Create `skill/test/asset.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const ROOT = new URL("../../", import.meta.url);

test("vendored asset is byte-identical to the built bundle", async () => {
  const built = await readFile(new URL("dist/unithread.bundle.js", ROOT));
  const vendored = await readFile(new URL("skill/assets/unithread.bundle.js", ROOT));
  assert.equal(sha(vendored), sha(built), "run `npm run skill:sync` — the vendored bundle is stale");
});

test("vendored asset is importable and exports the public API", async () => {
  const m = await import(new URL("skill/assets/unithread.bundle.js", ROOT).href);
  for (const name of ["runInThread", "Task", "WorkerPool", "spawnRemote", "SharedCounter", "Mutex", "Signal"]) {
    assert.equal(typeof m[name], "function", `missing export: ${name}`);
  }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test skill/test/asset.test.mjs`
Expected: FAIL — `ENOENT` on `skill/assets/unithread.bundle.js` (it does not exist yet).

- [ ] **Step 3: Write the sync script**

Create `scripts/sync-skill-asset.mjs`:

```js
// Copies the built bundle into the skill so the skill is self-contained.
// The skill is useless if this drifts from the library, so it is a build step,
// never a hand-copy. `npm run build` runs it.
import { copyFile, mkdir } from "node:fs/promises";

const SRC = new URL("../dist/unithread.bundle.js", import.meta.url);
const DEST = new URL("../skill/assets/unithread.bundle.js", import.meta.url);

await mkdir(new URL("./", DEST), { recursive: true });
await copyFile(SRC, DEST);
console.log("synced skill/assets/unithread.bundle.js <- dist/unithread.bundle.js");
```

- [ ] **Step 4: Wire it into the build**

In `package.json`, replace the `scripts` block with:

```json
  "scripts": {
    "build": "tsc -p tsconfig.json && npm run bundle && npm run skill:sync",
    "bundle": "esbuild src/index.ts --bundle --format=esm --platform=neutral --external:node:* --outfile=dist/unithread.bundle.js && esbuild src/index.ts --bundle --minify --format=esm --platform=neutral --external:node:* --outfile=dist/unithread.bundle.min.js",
    "skill:sync": "node scripts/sync-skill-asset.mjs",
    "test": "node test/proof.test.mjs",
    "test:browser": "node test/browser.test.mjs",
    "test:skill": "node --test skill/test/",
    "demo": "node demo/serve.mjs"
  },
```

`.gitignore` currently ignores `dist/`. The vendored asset lives under `skill/` and is committed — no `.gitignore` change is needed, but verify with `git check-ignore skill/assets/unithread.bundle.js` (expected: no output, exit 1).

- [ ] **Step 5: Run the sync and the tests**

Run: `npm run build && node --test skill/test/asset.test.mjs`
Expected: PASS — 2 tests, both green.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/sync-skill-asset.mjs skill/
git commit -m "feat(skill): scaffold skill dir, vendor bundle via build step"
```

---

### Task 2: Gate 1 — `verify-portable.mjs`

Proves a function survives the thread boundary by **spawning it in a real worker**, not by parsing an AST. A captured variable typechecks and lints cleanly, then dies at runtime with `ReferenceError` inside the worker; this gate provokes that failure on purpose and names the leaked identifier.

**Files:**
- Create: `skill/scripts/verify-portable.mjs`
- Create: `skill/test/fixtures/candidates.mjs`
- Create: `skill/test/verify-portable.test.mjs`

**Interfaces:**
- Consumes: `skill/assets/unithread.bundle.js` (Task 1) — `Task.spawn(fn)`, `task.run(args)`, `task.terminate()`.
- Produces: `verifyPortable(fn, args) -> Promise<{ ok: boolean, value?: unknown, leaked: string | null, error: string | null }>`
- Produces: CLI `node skill/scripts/verify-portable.mjs <file.mjs#exportName> [argsJson]`, exit 0 on pass, 1 on fail.

- [ ] **Step 1: Write the fixtures**

Create `skill/test/fixtures/candidates.mjs`:

```js
// Fixtures for the portability gate. Deliberately includes a function that
// looks fine and is not.
const MULTIPLIER = 3; // captured from module scope — invisible across the boundary

/** Self-contained: everything it needs arrives as an argument. */
export const portable = (n) => {
  const fib = (x) => (x < 2 ? x : fib(x - 1) + fib(x - 2));
  return fib(n);
};

/** Captures MULTIPLIER. Typechecks, lints, passes review, dies in a worker. */
export const capturesModuleConst = (n) => n * MULTIPLIER;

/** Captures a browser global that does not exist in a worker. */
export const capturesDomGlobal = () => document.title;

/** Self-contained and async. */
export const portableAsync = async (n) => n * 2;
```

- [ ] **Step 2: Write the failing test**

Create `skill/test/verify-portable.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPortable } from "../scripts/verify-portable.mjs";
import { portable, portableAsync, capturesModuleConst, capturesDomGlobal } from "./fixtures/candidates.mjs";

test("self-contained function passes and returns its value", async () => {
  const r = await verifyPortable(portable, [10]);
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.value, 55);
});

test("async self-contained function passes", async () => {
  const r = await verifyPortable(portableAsync, [21]);
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.value, 42);
});

test("captured module constant fails and is named", async () => {
  const r = await verifyPortable(capturesModuleConst, [5]);
  assert.equal(r.ok, false);
  assert.equal(r.leaked, "MULTIPLIER");
});

test("captured DOM global fails and is named", async () => {
  const r = await verifyPortable(capturesDomGlobal, []);
  assert.equal(r.ok, false);
  assert.equal(r.leaked, "document");
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `node --test skill/test/verify-portable.test.mjs`
Expected: FAIL — cannot resolve `../scripts/verify-portable.mjs`.

- [ ] **Step 4: Implement the gate**

Create `skill/scripts/verify-portable.mjs`:

```js
#!/usr/bin/env node
// Gate 1 of the unithread skill: does this function survive the thread boundary?
//
// Shipped functions cross via Function.prototype.toString(), so anything they
// captured from an enclosing scope is simply absent on the other side. That
// failure is invisible to the typechecker and the linter. So we do not model it
// — we provoke it: spawn the function in a real worker and see what happens.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Task } from "../assets/unithread.bundle.js";

const NOT_DEFINED = /\b(\w+) is not defined\b/;

/**
 * @param {Function} fn   candidate to ship to a worker
 * @param {unknown[]} args sample args — must exercise the code path under test
 * @returns {Promise<{ok: boolean, value?: unknown, leaked: string|null, error: string|null}>}
 */
export async function verifyPortable(fn, args = []) {
  let task;
  try {
    task = await Task.spawn(fn);
    const value = await task.run(args);
    return { ok: true, value, leaked: null, error: null };
  } catch (err) {
    const message = err?.message ?? String(err);
    const match = NOT_DEFINED.exec(message);
    return { ok: false, leaked: match ? match[1] : null, error: message };
  } finally {
    await task?.terminate();
  }
}

// CLI: node verify-portable.mjs path/to/mod.mjs#exportName '[10]'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, argsJson = "[]"] = process.argv.slice(2);
  if (!target) {
    console.error("usage: verify-portable.mjs <file.mjs#exportName> [argsJson]");
    process.exit(2);
  }
  const [file, name = "default"] = target.split("#");
  const mod = await import(pathToFileURL(resolve(file)).href);
  const fn = mod[name];
  if (typeof fn !== "function") {
    console.error(`FAIL  ${target} is not a function (got ${typeof fn})`);
    process.exit(2);
  }
  const r = await verifyPortable(fn, JSON.parse(argsJson));
  if (r.ok) {
    console.log(`PASS  portable — worker returned ${JSON.stringify(r.value)}`);
    process.exit(0);
  }
  if (r.leaked) {
    console.error(`FAIL  not portable — "${r.leaked}" was captured from the enclosing scope.`);
    console.error(`      It does not exist inside the worker. Pass it as an argument instead.`);
  } else {
    console.error(`FAIL  worker threw: ${r.error}`);
  }
  process.exit(1);
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test skill/test/verify-portable.test.mjs`
Expected: PASS — 4 tests green.

- [ ] **Step 6: Exercise the CLI both ways**

Run: `node skill/scripts/verify-portable.mjs skill/test/fixtures/candidates.mjs#portable '[10]'`
Expected: `PASS  portable — worker returned 55`, exit 0.

Run: `node skill/scripts/verify-portable.mjs skill/test/fixtures/candidates.mjs#capturesModuleConst '[5]'; echo "exit=$?"`
Expected: `FAIL  not portable — "MULTIPLIER" was captured from the enclosing scope.` and `exit=1`.

- [ ] **Step 7: Commit**

```bash
git add skill/scripts/verify-portable.mjs skill/test/
git commit -m "feat(skill): gate 1 — prove functions survive the thread boundary"
```

---

### Task 3: Gate 2 — `measure.mjs`, Node mode

Measures how long the **main thread** is blocked while a callable runs. This is the metric that decides whether an offload was real. It must also refuse to measure on a busy machine.

**Files:**
- Create: `skill/scripts/measure.mjs`
- Create: `skill/test/measure.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure Node).
- Produces: `measureBlocking(run, opts?) -> Promise<{ wallMs: number, worstBlockMs: number, value: unknown }>`
- Produces: `measureNoise(ms?) -> Promise<number>` — idle worst-lag, used as the quiet-machine check.
- Produces: CLI `node skill/scripts/measure.mjs <file.mjs#exportName> [argsJson]`.

- [ ] **Step 1: Write the failing test**

Create `skill/test/measure.test.mjs`. Note the first test: it is the regression guard for the settle bug named in Global Constraints — an implementation that stops sampling the instant the callable returns reports `worstBlockMs ≈ 0` here and fails.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { measureBlocking, measureNoise } from "../scripts/measure.mjs";

const blockFor = (ms) => () => {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
  return "done";
};

test("a synchronous block is reported, not missed", async () => {
  const r = await measureBlocking(blockFor(200));
  // The delayed tick carrying the real lag fires AFTER the block ends. If the
  // implementation stops sampling on return, this reads ~0 and the gate is a lie.
  assert.ok(r.worstBlockMs > 150, `expected >150ms block, got ${r.worstBlockMs}`);
  assert.ok(r.wallMs > 150, `expected >150ms wall, got ${r.wallMs}`);
  assert.equal(r.value, "done");
});

test("async work that does not block the main thread reports a small block", async () => {
  const r = await measureBlocking(async () => {
    await new Promise((res) => setTimeout(res, 200));
    return "slept";
  });
  assert.ok(r.worstBlockMs < 50, `expected a small block, got ${r.worstBlockMs}`);
  assert.ok(r.wallMs > 150, `expected >150ms wall, got ${r.wallMs}`);
  assert.equal(r.value, "slept");
});

test("noise on an idle machine is small", async () => {
  const noise = await measureNoise(300);
  assert.ok(noise < 50, `machine is not quiet: ${noise}ms idle lag`);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test skill/test/measure.test.mjs`
Expected: FAIL — cannot resolve `../scripts/measure.mjs`.

- [ ] **Step 3: Implement the measurement**

Create `skill/scripts/measure.mjs`:

```js
#!/usr/bin/env node
// Gate 2 of the unithread skill: did the main thread actually get freed?
//
// Two hazards are designed around here, both learned the hard way in this repo:
//
// 1. A stall is observed LATE. While the main thread is blocked no timer can
//    fire; the tick carrying the real lag lands only once the block ends. Stop
//    sampling the moment the callable returns and you measure ~0ms during a
//    1.2s freeze. So we settle extra ticks before clearing the sampler.
// 2. A busy machine produces confident, wrong numbers. Measure the idle noise
//    first and refuse to report if the machine is not quiet.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const SAMPLE_MS = 5;
const SETTLE_TICKS = 4;

/** Worst idle event-loop lag over `ms`. The machine's noise floor. */
export async function measureNoise(ms = 300) {
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - SAMPLE_MS);
    last = now;
  }, SAMPLE_MS);
  await new Promise((res) => setTimeout(res, ms));
  clearInterval(timer);
  return Math.max(0, Math.round(worst));
}

/**
 * Run `run()` while sampling event-loop lag on the main thread.
 * @param {() => unknown | Promise<unknown>} run
 * @returns {Promise<{wallMs: number, worstBlockMs: number, value: unknown}>}
 */
export async function measureBlocking(run) {
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - SAMPLE_MS);
    last = now;
  }, SAMPLE_MS);

  const t0 = performance.now();
  const value = await run();
  const wallMs = performance.now() - t0;

  // Settle: let the delayed tick that carries the real lag actually land.
  for (let i = 0; i < SETTLE_TICKS; i++) {
    await new Promise((res) => setTimeout(res, SAMPLE_MS));
  }
  clearInterval(timer);

  return { wallMs: Math.round(wallMs), worstBlockMs: Math.max(0, Math.round(worst)), value };
}

// CLI: node measure.mjs path/to/mod.mjs#exportName '[40]'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, argsJson = "[]"] = process.argv.slice(2);
  if (!target) {
    console.error("usage: measure.mjs <file.mjs#exportName> [argsJson]");
    process.exit(2);
  }
  const noise = await measureNoise(300);
  if (noise > 20) {
    console.error(`REFUSED  machine is busy (${noise}ms idle event-loop lag).`);
    console.error(`         Close other workloads and re-run. A busy machine gives wrong numbers.`);
    process.exit(2);
  }
  const [file, name = "default"] = target.split("#");
  const mod = await import(pathToFileURL(resolve(file)).href);
  const fn = mod[name];
  if (typeof fn !== "function") {
    console.error(`measure: ${target} is not a function (got ${typeof fn})`);
    process.exit(2);
  }
  const args = JSON.parse(argsJson);
  const r = await measureBlocking(() => fn(...args));
  console.log(`noise floor    ${noise} ms`);
  console.log(`wall clock     ${r.wallMs} ms`);
  console.log(`main-thread block ${r.worstBlockMs} ms   ${r.worstBlockMs > 16 ? "<- blocks the main thread" : "(under one frame)"}`);
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test skill/test/measure.test.mjs`
Expected: PASS — 3 tests green. If test 1 fails with `expected >150ms block, got 0`, the settle loop is missing or `clearInterval` runs too early.

- [ ] **Step 5: Exercise the CLI**

Run: `node skill/scripts/measure.mjs skill/test/fixtures/candidates.mjs#portable '[35]'`
Expected: three lines; `main-thread block` is a three-digit millisecond number followed by `<- blocks the main thread`.

- [ ] **Step 6: Commit**

```bash
git add skill/scripts/measure.mjs skill/test/measure.test.mjs
git commit -m "feat(skill): gate 2 — measure main-thread blocking, settle the late tick"
```

---

### Task 4: Gate 2 — `measure.mjs`, browser mode

Same gate, browser metric: worst frame time and fps. Playwright is optional; without it the script says so and exits cleanly rather than crashing.

**Files:**
- Modify: `skill/scripts/measure.mjs` (append browser mode + extend the CLI)
- Create: `skill/test/measure-browser.test.mjs`

**Interfaces:**
- Consumes: `measureNoise` (Task 3).
- Produces: `measureFrames(url, { action, seconds }) -> Promise<{ fps: number, worstFrameMs: number }>`
- Produces: CLI `node skill/scripts/measure.mjs --browser <url> [--action <js>] [--seconds N]`.

- [ ] **Step 1: Write the failing test**

Create `skill/test/measure-browser.test.mjs`. It measures this repo's own demo, which is a fixture with a known-bad and known-good state.

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { measureFrames } from "../scripts/measure.mjs";

let server;
const URL_ = "http://localhost:8099";

before(async () => {
  server = spawn("node", ["demo/serve.mjs"], { env: { ...process.env, PORT: "8099" }, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 700));
});
after(() => server?.kill());

test("main-thread workload is seen as jank", async () => {
  const r = await measureFrames(URL_, {
    action: "document.getElementById('btnMain').click()",
    seconds: 4,
  });
  assert.ok(r.worstFrameMs > 60, `expected jank, got ${r.worstFrameMs}ms worst frame`);
  assert.ok(r.fps < 40, `expected low fps, got ${r.fps}`);
});

test("worker workload is seen as smooth", async () => {
  const r = await measureFrames(URL_, {
    action: "document.getElementById('btnWorker').click()",
    seconds: 4,
  });
  assert.ok(r.worstFrameMs < 50, `expected smooth, got ${r.worstFrameMs}ms worst frame`);
  assert.ok(r.fps > 45, `expected high fps, got ${r.fps}`);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test skill/test/measure-browser.test.mjs`
Expected: FAIL — `measureFrames` is not exported.

- [ ] **Step 3: Implement browser mode**

Append to `skill/scripts/measure.mjs`, above the CLI block:

```js
/**
 * Sample main-thread frame times in a real browser while `action` runs.
 * Playwright is an optional dependency — absent, this reports and gives up.
 * @param {string} url
 * @param {{action?: string, seconds?: number}} opts
 * @returns {Promise<{fps: number, worstFrameMs: number}>}
 */
export async function measureFrames(url, { action = "", seconds = 4 } = {}) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error(
      "browser mode needs playwright: npm i -D playwright && npx playwright install chromium",
    );
  }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  if (action) await page.evaluate(action);

  const result = await page.evaluate(async (ms) => {
    // rAF-driven: a CSS animation would keep running on the compositor while the
    // main thread is blocked, and would hide exactly the jank we are looking for.
    const dts = [];
    let last = performance.now();
    let stop = false;
    requestAnimationFrame(function loop(t) {
      dts.push(t - last);
      last = t;
      if (!stop) requestAnimationFrame(loop);
    });
    await new Promise((r) => setTimeout(r, ms));
    // Settle: after a stall Chromium dispatches the queued frame with a stale
    // timestamp, and only the NEXT frame carries the real jump.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    stop = true;
    return dts;
  }, seconds * 1000);

  await browser.close();
  const worstFrameMs = Math.round(Math.max(...result));
  const fps = Math.round(result.length / seconds);
  return { fps, worstFrameMs };
}
```

Then extend the CLI block: before the existing positional-argument handling, add

```js
  if (process.argv[2] === "--browser") {
    const url = process.argv[3];
    const actionIdx = process.argv.indexOf("--action");
    const secondsIdx = process.argv.indexOf("--seconds");
    const action = actionIdx > -1 ? process.argv[actionIdx + 1] : "";
    const seconds = secondsIdx > -1 ? Number(process.argv[secondsIdx + 1]) : 4;
    const r = await measureFrames(url, { action, seconds });
    console.log(`fps            ${r.fps}`);
    console.log(`worst frame    ${r.worstFrameMs} ms   ${r.worstFrameMs > 16.7 ? "<- dropped frames" : "(within budget)"}`);
    process.exit(0);
  }
```

- [ ] **Step 4: Run the tests**

Run: `node --test skill/test/measure-browser.test.mjs`
Expected: PASS — 2 tests. The main-thread case reports a worst frame of roughly 100–180 ms; the worker case roughly 15–35 ms.

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/measure.mjs skill/test/measure-browser.test.mjs
git commit -m "feat(skill): gate 2 browser mode — frame-time sampling with stale-frame settle"
```

---

### Task 5: `SKILL.md` and the API reference

The knowledge half. `SKILL.md` is what the agent reads; it must make the four phases and the hard rules unavoidable.

**Files:**
- Create: `skill/SKILL.md`
- Create: `skill/references/api.md`

**Interfaces:**
- Consumes: both gates (Tasks 2–4), referenced by exact path.

- [ ] **Step 1: Write `skill/SKILL.md`**

```markdown
---
name: unithread
description: Move CPU-bound work off the main thread using real OS threads (Web Workers / node:worker_threads) via unithread. Use when a UI janks or freezes, an event loop is blocked, a page locks up during heavy computation, or the user asks to parallelise a loop, use worker threads, offload work, or make something stop blocking.
---

# unithread — offload CPU work onto real threads

Audit a codebase for main-thread hogs, move them onto real OS threads, and prove they moved.
One API works in both Node and browsers.

## The rule that breaks everything

Shipped functions cross the thread boundary via `Function.prototype.toString()`. **Anything they
captured from an enclosing scope does not exist on the other side.** It typechecks. It lints. It
passes review. It throws `ReferenceError` at runtime inside the worker.

```js
const MULTIPLIER = 3;
runInThread((n) => n * MULTIPLIER, 5);   // ReferenceError: MULTIPLIER is not defined
runInThread((n, m) => n * m, 5, 3);      // correct — everything arrives as an argument
```

Data crosses as arguments, transferables, or `SharedArrayBuffer`. Nothing else.

## Workflow

### 1. Audit — measure, never guess

Find CPU-bound **synchronous** work: pixel/matrix loops, parse or serialise of large payloads,
hashing, compression, recursive search. Then time the candidates on representative input:

    node <skill>/scripts/measure.mjs path/to/mod.mjs#exportName '[args]'

**Do not offload anything under ~16 ms.** The round-trip plus structured clone costs more than
the work. Present the ranked candidates with their measured costs and let the user choose.

Workers are for **CPU**, not I/O. Async I/O already yields; a thread buys nothing.

### 2. Baseline — on a quiet machine

Record the metric before changing anything. `measure.mjs` refuses to run when the machine is
busy, because a busy machine produces confident, wrong conclusions.

- Node: `main-thread block` in ms.
- Browser: `node <skill>/scripts/measure.mjs --browser <url> --action "<js>"` → fps + worst frame.

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

**Gate 1 — portability.** Spawn the candidate in a real worker:

    node <skill>/scripts/verify-portable.mjs path/to/mod.mjs#exportName '[args]'

Fails → it names the captured identifier. Pass it as an argument and re-run.

Limitation: the gate runs the function with the sample args you give it. Args must exercise the
code path, or a capture on an untaken branch will slip through.

**Gate 2 — improvement.** Re-measure the Phase 2 metric and report **both numbers**.

    BEFORE  worst frame 133 ms / 16 fps
    AFTER   worst frame  18 ms / 59 fps

**If the number did not move, say so and revert.** "It compiles", "no errors", and "tests pass"
are not evidence: no test suite notices jank. A no-op offload is never reported as a win.

## API

See `references/api.md` for the full surface and the browser/Node differences.
```

- [ ] **Step 2: Write `skill/references/api.md`**

Cover, with a runnable snippet each: `runInThread`, `Task.spawn` / `run` / `call` / `onEvent` /
`terminate`, `Task.spawnService`, `spawnRemote` / `wrap`, `WorkerPool.create` / `exec` / `map` /
`close`, `SharedCounter`, `Mutex` (`lock` / `lockAsync` / `withLock`), `Signal` (`wait` /
`waitAsync` / `fire`), `isNode`, `hardwareConcurrency`, `hasSharedMemory`, and the `WorkerEnv`
last-argument (`isMainThread`, `threadId`, `runtime`, `emit`, `transfer`). State plainly:
`Atomics.wait` is forbidden on the browser main thread — use `lockAsync()` / `waitAsync()` there;
Node has no such restriction. Source of truth for signatures: `src/index.ts` and `README.md`.

- [ ] **Step 3: Verify the frontmatter parses and the skill is discoverable**

Run: `head -4 skill/SKILL.md`
Expected: a `---` fenced block with `name: unithread` and a one-line `description:`.

- [ ] **Step 4: Commit**

```bash
git add skill/SKILL.md skill/references/api.md
git commit -m "docs(skill): SKILL.md workflow + hard rules, API reference"
```

---

### Task 6: End-to-end fixture + install

Prove the whole skill works on a real offload, and make it installable.

**Files:**
- Create: `skill/test/e2e.test.mjs`
- Modify: `README.md` (add an "Agent skill" section)

**Interfaces:**
- Consumes: `verifyPortable` (Task 2), `measureBlocking` (Task 3), the vendored bundle (Task 1).

- [ ] **Step 1: Write the end-to-end test**

Create `skill/test/e2e.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPortable } from "../scripts/verify-portable.mjs";
import { measureBlocking } from "../scripts/measure.mjs";
import { WorkerPool } from "../assets/unithread.bundle.js";
import { portable, capturesModuleConst } from "./fixtures/candidates.mjs";

test("a good offload passes gate 1 and frees the main thread in gate 2", async () => {
  // Gate 1
  const gate1 = await verifyPortable(portable, [30]);
  assert.equal(gate1.ok, true, gate1.error ?? "");

  // Gate 2 — before: the work runs on the main thread and blocks it.
  const before = await measureBlocking(() => [32, 32, 32, 32].map((n) => portable(n)));
  assert.ok(before.worstBlockMs > 50, `expected a real block, got ${before.worstBlockMs}ms`);

  // Gate 2 — after: the same work on a pool. The main thread stays free.
  const pool = await WorkerPool.create(portable, 4);
  const after = await measureBlocking(() => pool.map([32, 32, 32, 32], (n) => [n]));
  await pool.close();

  assert.ok(
    after.worstBlockMs < before.worstBlockMs / 2,
    `offload did not free the main thread: before=${before.worstBlockMs}ms after=${after.worstBlockMs}ms`,
  );
});

test("a bad offload is caught by gate 1 before any of this", async () => {
  const gate1 = await verifyPortable(capturesModuleConst, [5]);
  assert.equal(gate1.ok, false);
  assert.equal(gate1.leaked, "MULTIPLIER");
});
```

- [ ] **Step 2: Run it**

Run: `node --test skill/test/e2e.test.mjs`
Expected: PASS — 2 tests. The first prints no numbers but asserts the main-thread block at least
halves when the same work moves to the pool.

- [ ] **Step 3: Run the whole suite**

Run: `npm run build && npm test && npm run test:skill`
Expected: library 21/21 PASS; skill tests all green.

- [ ] **Step 4: Document installation in `README.md`**

Add before `## Build / test / demo`:

```markdown
## Agent skill

`skill/` packages unithread as a Claude Code skill: an agent can audit a codebase for
main-thread hogs, offload them to threads, and prove the main thread was freed.

    ln -s "$PWD/skill" ~/.claude/skills/unithread

Then ask an agent to "make this app stop janking". It will measure candidates, refuse to
offload anything under ~16 ms, verify the shipped function captures nothing, and report a
before/after — reverting if the number did not move.
```

- [ ] **Step 5: Install it and confirm discovery**

Run: `ln -s "$PWD/skill" ~/.claude/skills/unithread && ls -l ~/.claude/skills/unithread/SKILL.md`
Expected: the symlink resolves to `skill/SKILL.md`.

- [ ] **Step 6: Commit**

```bash
git add skill/test/e2e.test.mjs README.md
git commit -m "test(skill): end-to-end gates on a real offload; document install"
```

---

## Self-Review

**Spec coverage:** Packaging/layout → Task 1, 5. Phase 1 audit (measure, don't guess; 16 ms floor) → Task 3 + SKILL.md. Phase 2 baseline + quiet machine → Task 3 (`measureNoise`, `REFUSED`). Phase 3 offload (vendor, self-contained, primitives, transferables, SAB) → Task 5. Phase 4 Gate 1 → Task 2. Gate 4 Gate 2 → Tasks 3–4. Hard rules 1–7 → SKILL.md (Task 5), enforced by Tasks 2–3. Error handling → Task 2 (leaked identifier), Task 6 (revert on no improvement), Task 4 (playwright absent). Testing (fib fixture passes both gates; capture fails Gate 1) → Task 6. Open item (git init) → done before this plan.

**Placeholder scan:** No TBD/TODO. Task 5 Step 2 (`api.md`) is the one prose-specified file — it enumerates every symbol to document and names `src/index.ts` as the signature source of truth, so it is a checklist, not a placeholder.

**Type consistency:** `verifyPortable(fn, args) -> {ok, value, leaked, error}` — same shape in Tasks 2 and 6. `measureBlocking(run) -> {wallMs, worstBlockMs, value}` — same in Tasks 3 and 6. `measureFrames(url, {action, seconds}) -> {fps, worstFrameMs}` — same in Task 4. Fixture exports `portable`, `portableAsync`, `capturesModuleConst`, `capturesDomGlobal` — used consistently in Tasks 2 and 6.
