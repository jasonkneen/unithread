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
