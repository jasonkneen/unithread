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
