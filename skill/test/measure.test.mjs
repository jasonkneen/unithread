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
