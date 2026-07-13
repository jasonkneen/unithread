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
