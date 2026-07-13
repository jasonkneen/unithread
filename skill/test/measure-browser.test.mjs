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

// IMPORTANT 4 / MINOR 5: gate on `jankFrames`/`jankPct`, not `worstFrameMs` or
// `fps`. A single worst-frame reading sits close to the noise floor (this
// suite has been observed to report 67ms then 50ms against a `< 50` threshold
// on an idle machine — a flaky gate), while the jank *percentage* separates
// cleanly: ~98% of frames over budget on the main thread vs. ~0% on workers.
// `fps` is excluded entirely per SKILL.md and this file's own header comment:
// headless Chromium is not vsync-capped, so it must never be compared to 60.
test("main-thread workload is seen as jank", async () => {
  const r = await measureFrames(URL_, {
    action: "document.getElementById('btnMain').click()",
    seconds: 4,
  });
  assert.ok(
    r.jankPct > 80,
    `expected heavy jank, got ${r.jankPct}% (${r.jankFrames}/${r.totalFrames}, worst=${r.worstFrameMs}ms)`,
  );
});

test("worker workload is seen as smooth", async () => {
  const r = await measureFrames(URL_, {
    action: "document.getElementById('btnWorker').click()",
    seconds: 4,
  });
  assert.ok(
    r.jankPct < 10,
    `expected minimal jank, got ${r.jankPct}% (${r.jankFrames}/${r.totalFrames}, worst=${r.worstFrameMs}ms)`,
  );
});
