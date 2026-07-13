import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { measureBlocking, measureNoise } from "../scripts/measure.mjs";

const CLI = fileURLToPath(new URL("../scripts/measure.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/measure-fixtures.mjs", import.meta.url));

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

test("measureBlocking propagates the callable's async rejection and still stops the sampler", async () => {
  // Regression: `sampler.stop()` used to sit after `await run()` with no
  // `finally`. A throwing callable skipped it entirely, leaking the
  // `setInterval` forever — the process (and `node --test`) never exited.
  // Every candidate this gate vets is arbitrary CPU code; a throw is routine.
  // The guard here is blunt but effective: if the interval leaked, this test
  // — and the rest of the suite after it — would never finish on its own.
  await assert.rejects(
    () =>
      measureBlocking(async () => {
        throw new Error("boom");
      }),
    /boom/,
  );
});

test("measureBlocking propagates a synchronous throw too, and still stops the sampler", async () => {
  await assert.rejects(
    () =>
      measureBlocking(() => {
        throw new Error("bang");
      }),
    /bang/,
  );
});

test("measureBlocking reports a noise floor before and after the run", async () => {
  const r = await measureBlocking(() => "value");
  assert.equal(typeof r.noiseBeforeMs, "number");
  assert.equal(typeof r.noiseAfterMs, "number");
  assert.ok(r.noiseBeforeMs < 50, `expected a quiet before-floor, got ${r.noiseBeforeMs}`);
  assert.ok(r.noiseAfterMs < 50, `expected a quiet after-floor, got ${r.noiseAfterMs}`);
  assert.equal(r.value, "value");
});

test("noiseAfterMs catches contention that starts only after run() returns", async () => {
  // The measured block itself is tiny — run() returns immediately. A
  // pre-run-only noise check (the bug this fix addresses) would have no way
  // to see the contention that starts a few milliseconds later.
  const r = await measureBlocking(() => {
    setTimeout(() => {
      const end = performance.now() + 200;
      while (performance.now() < end) {}
    }, 50);
    return "ok";
  });
  assert.ok(r.noiseAfterMs > 20, `expected a contaminated after-floor, got ${r.noiseAfterMs}`);
  assert.equal(r.value, "ok");
});

test("CLI prints both noise floors on a normal run", () => {
  const stdout = execFileSync(process.execPath, [CLI, `${FIXTURES}#quick`, "[41]"], {
    encoding: "utf8",
  });
  assert.match(stdout, /noise floor \(before\)/);
  assert.match(stdout, /noise floor \(after\)/);
  assert.match(stdout, /wall clock/);
  assert.match(stdout, /main-thread block/);
});

test("CLI refuses (non-zero exit) when the after-floor is contaminated, but still prints both floors", () => {
  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [CLI, `${FIXTURES}#noisyAfterReturn`, "[]"], {
      encoding: "utf8",
    });
  } catch (err) {
    stdout = err.stdout ?? "";
    status = err.status;
  }
  assert.match(stdout, /noise floor \(before\)/);
  assert.match(stdout, /noise floor \(after\)/);
  assert.notEqual(status, 0, "CLI should exit non-zero when a noise floor is contaminated");
});
