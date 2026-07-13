import { test } from "node:test";
import assert from "node:assert/strict";
import { measureFrames } from "../scripts/measure.mjs";

// CRITICAL 1 regression: the sampler used to be armed AFTER the action was
// awaited to completion (`await page.evaluate(action)` then a separate
// `page.evaluate(sampler)`). A synchronously-blocking action was therefore
// always over by the time a single frame was sampled, and got reported as
// smooth — the worst possible defect for a gate whose whole job is proving
// the main thread was freed. No server needed: about:blank is enough to
// prove the ordering, independent of the repo's demo fixture.
test("a synchronous main-thread freeze is detected, not reported as smooth", async () => {
  const r = await measureFrames("about:blank", {
    action: "(function(){ const end = Date.now() + 1200; while (Date.now() < end) {} })()",
    seconds: 2,
  });
  assert.ok(
    r.worstFrameMs > 800,
    `expected the ~1200ms freeze to show up as a dropped frame, got ${r.worstFrameMs}ms worst frame`,
  );
});

// CRITICAL 2 regression: there was no try/finally around browser.close(). A
// throwing action (e.g. a bad selector) left the caller's catch firing but
// Chromium never closed, hanging the process (and node --test) after the
// assertion already ran. This test passing AND the process going on to exit
// on its own (no external timeout needed) is the proof.
test("measureFrames rejects when the action throws, and still closes the browser", async () => {
  await assert.rejects(() =>
    measureFrames("about:blank", {
      action: "document.getElementById('doesNotExist').click()",
      seconds: 1,
    }),
  );
});
