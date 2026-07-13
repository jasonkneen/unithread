#!/usr/bin/env node
// Gate 1 of the unithread skill: does this function survive the thread boundary,
// AND does it compute the same thing there as it does here?
//
// Shipped functions cross via Function.prototype.toString(), so anything they
// captured from an enclosing scope is simply absent on the other side. That
// failure is invisible to the typechecker and the linter. Worse: a capture
// guarded by a `typeof x !== "undefined"` check does not throw at all — it
// just silently takes the other branch and returns a wrong answer. So this
// gate does not just ask "did it throw?" — it asks "does it compute the same
// thing on both sides?" by running the candidate on the main thread AND in a
// real worker with the same args, then deep-comparing the two results
// (node:util's isDeepStrictEqual).
//
// IMPORTANT — the candidate runs TWICE (once per side). If the function has
// side effects (writes a file, increments an external counter, sends a
// network request, mutates a shared object it was given), those side effects
// happen twice. That is a real hazard for this gate, not a hypothetical one —
// know what you're passing in before you call this on anything but a pure
// function.
//
// IMPORTANT — a non-deterministic function (Math.random(), Date.now(), an
// external clock/counter) will legitimately compute two different results and
// be reported as "diverged" even though it is perfectly portable. That is a
// false alarm from this gate, not a bug in your function. If you know the
// candidate is intentionally non-deterministic, opt out of the comparison
// with `{ compare: false }` (or `--no-compare` on the CLI) — this restores
// the older, weaker "did it throw?" check and also means the candidate only
// runs once, in the worker.
//
// IMPORTANT — a function that mutates its input in place and returns nothing
// is the headline use case for this skill (pixel/matrix loops, transferables,
// SharedArrayBuffer) and it is exactly the case a return-value comparison
// cannot see: both sides return `undefined`, so `undefined === undefined`
// "passes" while proving nothing about whether the mutation itself was
// correct on the worker side. So when BOTH sides return `undefined`, this
// gate refuses to call that a pass — it reports `reason: "vacuous"` instead.
// Give the candidate something checkable to return (even just for this
// check), or re-run with `--no-compare` if you knowingly accept that the
// comparison cannot help you here.
//
// The worker side always receives a trailing WorkerEnv (see src/spawn.ts —
// the "call" protocol path appends `env` after the shipped args). A
// documented `(n, env) => …` signature (blessed for runInThread, Task.spawn,
// and WorkerPool in references/api.md) must see that same shape on the main
// thread, or this gate reports a capture that does not exist. So the
// main-thread invocation is given a stub WorkerEnv as its trailing argument
// too — same arity, same shape, both sides.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Task } from "../assets/unithread.bundle.js";

const NOT_DEFINED = /\b(\w+) is not defined\b/;

// Mirrors the shape the worker bootstrap builds in src/spawn.ts (`_bootstrap`)
// closely enough for comparison purposes: same fields, inert no-op methods.
// `isMainThread: true` / `threadId: 0` / `runtime: "main"` are deliberately
// NOT what the worker side sees (`false` / a real thread id / "node"|"web") —
// a candidate that branches on those fields is making a real, observable
// decision based on which side it's running on, and this stub does not try
// to hide that from the comparison.
const STUB_MAIN_ENV = Object.freeze({
  isMainThread: true,
  threadId: 0,
  runtime: "main",
  emit() {},
  transfer(v) {
    return v;
  },
});

/**
 * @param {Function} fn   candidate to ship to a worker
 * @param {unknown[]} args sample args — must exercise the code path under test
 * @param {{compare?: boolean}} [options]
 *   compare (default true): also run `fn` on the main thread with the same
 *   args and deep-compare the two results. Runs the candidate a second time —
 *   see the file header. Set false to skip this and only check "did it
 *   throw?" (useful for intentionally non-deterministic candidates).
 * @returns {Promise<{
 *   ok: boolean,
 *   value?: unknown,
 *   mainValue?: unknown,
 *   leaked: string|null,
 *   reason: "captured"|"diverged"|"vacuous"|"threw"|null,
 *   error: string|null,
 * }>}
 */
export async function verifyPortable(fn, args = [], { compare = true } = {}) {
  let task;
  let workerOk;
  let workerValue;
  let workerErr;
  try {
    task = await Task.spawn(fn);
    try {
      workerValue = await task.run(args);
      workerOk = true;
    } catch (err) {
      workerOk = false;
      workerErr = err;
    }
  } finally {
    await task?.terminate();
  }

  if (!workerOk) {
    const message = workerErr?.message ?? String(workerErr);
    const match = workerErr?.name === "ReferenceError" ? NOT_DEFINED.exec(message) : null;
    if (match) {
      return { ok: false, leaked: match[1], reason: "captured", error: message };
    }
    // The worker threw, but not a leaked-identifier ReferenceError. That is
    // the candidate raising its own error — the candidate's business, not a
    // boundary problem.
    return { ok: false, leaked: null, reason: "threw", error: message };
  }

  if (!compare) {
    return { ok: true, value: workerValue, leaked: null, reason: null, error: null };
  }

  // Run the same candidate, with the same args, on the main thread — this is
  // the second execution documented in the file header. Append the same
  // trailing WorkerEnv shape the worker side receives (src/spawn.ts's "call"
  // path), so a documented `(n, env) => …` signature gets the same arity on
  // both sides instead of a false "captured" report.
  let mainOk;
  let mainValue;
  let mainErr;
  try {
    mainValue = await fn(...args, STUB_MAIN_ENV);
    mainOk = true;
  } catch (err) {
    mainOk = false;
    mainErr = err;
  }

  if (!mainOk) {
    // The worker succeeded but the main thread threw. Behavior differs across
    // the boundary either way, so this is a divergence, not a capture (the
    // worker didn't throw a ReferenceError) and not a "threw" (the worker's
    // side, the one that matters for shipping, actually ran fine).
    const message = mainErr?.message ?? String(mainErr);
    return { ok: false, value: workerValue, leaked: null, reason: "diverged", error: message };
  }

  if (mainValue === undefined && workerValue === undefined) {
    // Both sides returned nothing. `undefined === undefined` would otherwise
    // sail through the equality check below and report `ok: true` — exactly
    // the bug this gate exists to catch for in-place mutation, transferables,
    // and SharedArrayBuffer workloads, none of which need a return value to
    // do real (and possibly wrong) work. A comparison of two "nothing"s has
    // proved nothing, so this is neither a pass nor a "diverged" failure —
    // it's its own reason so the message can say what actually happened.
    return {
      ok: false,
      value: workerValue,
      mainValue,
      leaked: null,
      reason: "vacuous",
      error: null,
    };
  }

  if (!isDeepStrictEqual(mainValue, workerValue)) {
    return {
      ok: false,
      value: workerValue,
      mainValue,
      leaked: null,
      reason: "diverged",
      error: null,
    };
  }

  return { ok: true, value: workerValue, mainValue, leaked: null, reason: null, error: null };
}

const USAGE = `usage: verify-portable.mjs [--no-compare] <file.mjs#exportName> [argsJson]

Gate 1: proves a candidate function survives being shipped to a worker
thread AND computes the same result there as it does on the main thread.

By default the candidate runs TWICE — once on the main thread, once in the
worker — and the results are deep-compared. Both sides also receive the same
trailing WorkerEnv the worker protocol injects, so a documented
"(n, env) => ..." signature compares correctly instead of reporting a false
capture. If your candidate has side effects, both executions happen for
real. If your candidate is non-deterministic (Math.random, Date.now, etc.),
the two runs will legitimately differ and this gate will report a false
"diverged" failure. If your candidate returns nothing on both sides (e.g. it
only mutates its input in place), the comparison has proved nothing and this
gate reports "vacuous" rather than a pass.

--no-compare skips the comparison entirely: the candidate then runs ONCE, in
the worker only, and this only checks "did it throw?" — it is honest about
what it does NOT check: a --no-compare pass says nothing about whether the
worker computed the right answer, only that it ran without erroring. Use it
for non-deterministic candidates, or for vacuous (nothing-returning)
candidates you knowingly accept the risk on.
`;

// CLI: node verify-portable.mjs [--no-compare] path/to/mod.mjs#exportName '[10]'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.error(USAGE);
    process.exit(0);
  }
  const compare = !rawArgs.includes("--no-compare");
  const positional = rawArgs.filter((a) => a !== "--no-compare");
  const [target, argsJson = "[]"] = positional;
  if (!target) {
    console.error(USAGE);
    process.exit(2);
  }
  const [file, name = "default"] = target.split("#");
  const mod = await import(pathToFileURL(resolve(file)).href);
  const fn = mod[name];
  if (typeof fn !== "function") {
    console.error(`FAIL  ${target} is not a function (got ${typeof fn})`);
    process.exit(2);
  }
  const r = await verifyPortable(fn, JSON.parse(argsJson), { compare });
  if (r.ok) {
    console.log(`PASS  portable — worker returned ${JSON.stringify(r.value)}`);
    process.exit(0);
  }
  if (r.reason === "captured") {
    console.error(`FAIL  not portable — "${r.leaked}" was captured from the enclosing scope.`);
    console.error(`      It does not exist inside the worker. Pass it as an argument instead.`);
  } else if (r.reason === "diverged") {
    console.error(`FAIL  not portable — the worker result diverged from the main-thread result.`);
    console.error(`      main:   ${JSON.stringify(r.mainValue)}`);
    console.error(`      worker: ${JSON.stringify(r.value)}`);
    console.error(`      Likely a captured variable silently swallowed by a guard (e.g.`);
    console.error(`      \`typeof x !== "undefined"\`). If this candidate is intentionally`);
    console.error(`      non-deterministic (Math.random, Date.now, ...), rerun with --no-compare.`);
    if (r.error) console.error(`      main-thread error: ${r.error}`);
  } else if (r.reason === "vacuous") {
    console.error(`FAIL  not verified — the function returns nothing on either side.`);
    console.error(`      Comparing "undefined" to "undefined" proves nothing about whether the`);
    console.error(`      worker computed the right thing (this is the common shape for in-place`);
    console.error(`      mutation, transferables, or SharedArrayBuffer workloads). Either have the`);
    console.error(`      function return something checkable, or re-run with --no-compare if you`);
    console.error(`      knowingly accept that this cannot be verified by comparison.`);
  } else {
    console.error(`FAIL  the candidate threw its own error — not a boundary problem: ${r.error}`);
  }
  process.exit(1);
}
