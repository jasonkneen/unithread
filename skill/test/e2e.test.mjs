import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPortable } from "../scripts/verify-portable.mjs";
import { measureBlocking } from "../scripts/measure.mjs";
import { WorkerPool } from "../assets/unithread.bundle.js";
import { portable, capturesModuleConst } from "./fixtures/candidates.mjs";

// fib(32) with fib(0)=0, fib(1)=1 — verified independently, not trusted from
// a review comment: 0,1,1,2,3,5,8,13,21,34,55,89,144,233,377,610,987,1597,
// 2584,4181,6765,10946,17711,28657,46368,75025,121393,196418,317811,514229,
// 832040,1346269,2178309 (index 32).
const FIB32 = 2178309;

test("a good offload passes gate 1 and frees the main thread in gate 2", async () => {
  // Gate 1
  const gate1 = await verifyPortable(portable, [30]);
  assert.equal(gate1.ok, true, gate1.error ?? "");
  assert.equal(gate1.reason, null);
  assert.equal(gate1.leaked, null);

  // Gate 2 — before: the work runs on the main thread and blocks it.
  const before = await measureBlocking(() => [32, 32, 32, 32].map((n) => portable(n)));
  assert.ok(before.worstBlockMs > 50, `expected a real block, got ${before.worstBlockMs}ms`);
  // IMPORTANT 3: assert the actual computed values, not just that the main
  // thread dropped. A pool whose map() returned [undefined, undefined,
  // undefined, undefined] would still pass the timing assertion below and
  // be reported as "main thread freed!" — exactly the failure this whole
  // branch exists to prevent, sitting inside its own end-to-end proof.
  assert.deepEqual(
    before.value,
    [FIB32, FIB32, FIB32, FIB32],
    `main-thread run computed the wrong answer: ${JSON.stringify(before.value)}`,
  );

  // Gate 2 — after: the same work on a pool. The main thread stays free.
  const pool = await WorkerPool.create(portable, 4);
  const after = await measureBlocking(() => pool.map([32, 32, 32, 32], (n) => [n]));
  await pool.close();

  assert.ok(
    after.worstBlockMs < before.worstBlockMs / 2,
    `offload did not free the main thread: before=${before.worstBlockMs}ms after=${after.worstBlockMs}ms`,
  );
  assert.deepEqual(
    after.value,
    [FIB32, FIB32, FIB32, FIB32],
    `offloaded run computed the wrong answer: ${JSON.stringify(after.value)}`,
  );
  assert.deepEqual(
    after.value,
    before.value,
    "same work, same answer, different thread — offloading must not change the result",
  );

  console.log(
    `e2e main-thread block  before=${before.worstBlockMs}ms  after=${after.worstBlockMs}ms  ` +
      `value=${JSON.stringify(after.value)}`,
  );
});

test("a bad offload is caught by gate 1 before any of this", async () => {
  const gate1 = await verifyPortable(capturesModuleConst, [5]);
  assert.equal(gate1.ok, false);
  assert.equal(gate1.leaked, "MULTIPLIER");
  assert.equal(gate1.reason, "captured");
});
