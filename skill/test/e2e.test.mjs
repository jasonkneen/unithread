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
  assert.equal(gate1.reason, null);
  assert.equal(gate1.leaked, null);

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

  console.log(
    `e2e main-thread block  before=${before.worstBlockMs}ms  after=${after.worstBlockMs}ms`,
  );
});

test("a bad offload is caught by gate 1 before any of this", async () => {
  const gate1 = await verifyPortable(capturesModuleConst, [5]);
  assert.equal(gate1.ok, false);
  assert.equal(gate1.leaked, "MULTIPLIER");
  assert.equal(gate1.reason, "captured");
});
