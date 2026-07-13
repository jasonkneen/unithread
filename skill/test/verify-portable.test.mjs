import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPortable } from "../scripts/verify-portable.mjs";
import {
  portable,
  portableAsync,
  capturesModuleConst,
  capturesDomGlobal,
  sneaky,
  throwsOwnError,
  nonDeterministic,
  mutatesInPlace,
  usesWorkerEnv,
} from "./fixtures/candidates.mjs";

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
  assert.equal(r.reason, "captured");
});

test("captured DOM global fails and is named", async () => {
  const r = await verifyPortable(capturesDomGlobal, []);
  assert.equal(r.ok, false);
  assert.equal(r.leaked, "document");
  assert.equal(r.reason, "captured");
});

test("typeof-guarded capture does not throw but diverges, and must fail", async () => {
  // In-process, MULT resolves via closure and the guard takes the "defined"
  // branch: 5 * 7 = 35. In the worker, MULT does not exist, the guard takes
  // the other branch, and it silently returns 5. A gate that only asks "did
  // it throw?" would call this portable. It is not.
  const r = await verifyPortable(sneaky, [5]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "diverged");
  assert.equal(r.value, 5, "worker took the unguarded branch");
  assert.equal(r.mainValue, 35, "main thread took the guarded branch");
});

test("candidate that throws its own error is reason 'threw', not 'captured'", async () => {
  const r = await verifyPortable(throwsOwnError, [5]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "threw");
  assert.equal(r.leaked, null);
});

test("non-deterministic candidate diverges by default", async () => {
  const r = await verifyPortable(nonDeterministic, []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "diverged");
});

test("non-deterministic candidate passes with compare: false", async () => {
  const r = await verifyPortable(nonDeterministic, [], { compare: false });
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(typeof r.value, "number");
});

test("CRITICAL 1: an in-place mutation that returns undefined on both sides is vacuous, not ok", async () => {
  // Reproduces the exact bug this gate exists to catch: the worker silently
  // takes the unguarded branch (K doesn't exist there) and writes 0 instead
  // of 5, but since the function returns nothing, a return-value comparison
  // sees undefined === undefined and would previously report `ok: true`.
  const r = await verifyPortable(mutatesInPlace, [[0]]);
  assert.equal(r.ok, false, "a vacuous comparison must never report ok: true");
  assert.equal(r.reason, "vacuous");
  assert.equal(r.value, undefined);
  assert.equal(r.mainValue, undefined);
});

test("CRITICAL 1: --no-compare still runs (once, in the worker) and is honest about what it skips", async () => {
  // --no-compare intentionally drops the comparison; a nothing-returning
  // candidate is expected to still report ok: true here, since the caller
  // asked only for "did it throw?", not "did the mutation come out right?".
  const r = await verifyPortable(mutatesInPlace, [[0]], { compare: false });
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.value, undefined);
  assert.equal(r.mainValue, undefined, "compare:false must not run the main thread at all");
});

test("IMPORTANT 2: a function using the documented trailing WorkerEnv now passes", async () => {
  // (n, env) => n + (env ? 1 : 0). Before the fix, the main-thread side of
  // the comparison called fn(...args) with NO env, so `env` was undefined
  // there but a real object in the worker — a false divergence/capture on a
  // signature api.md explicitly blesses for runInThread/Task.spawn/WorkerPool.
  const r = await verifyPortable(usesWorkerEnv, [5]);
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.value, 6, "worker side: env is truthy, 5 + 1");
  assert.equal(r.mainValue, 6, "main-thread side must now also receive a stub env");
});
