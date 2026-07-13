#!/usr/bin/env node
// Gate 2 of the unithread skill: did the main thread actually get freed?
//
// Three hazards are designed around here, learned the hard way in this repo:
//
// 1. A stall is observed LATE. While the main thread is blocked no timer can
//    fire; the tick carrying the real lag lands only once the block ends. Stop
//    sampling the moment the callable returns and you measure ~0ms during a
//    1.2s freeze. So we settle extra ticks before clearing the sampler — on
//    the success path AND when the callable throws (a `finally` guarantees
//    the sampler is always stopped; otherwise the interval leaks and the
//    process never exits).
// 2. A busy machine produces confident, wrong numbers. A single noise-floor
//    reading taken BEFORE the callable runs is not enough: this repo has seen
//    a clean pre-flight floor (14ms, under the 20ms gate) sit next to a block
//    reading inflated ~10x by contention that only showed up mid-run. So the
//    floor is sampled both before and after the run, and either reading above
//    threshold means "don't trust this number".
// 3. Residual limitation, stated honestly: a burst of contention that starts
//    AND fully subsides inside the run window — gone before the after-check
//    samples — is invisible to both floors. This gate catches contention that
//    is still present immediately before or immediately after the run; it
//    cannot see a spike confined entirely inside the window between them.
// 4. Browser mode (`measureFrames`) has its own version of hazard 1: the rAF
//    sampler MUST be armed before the action fires, in the SAME page.evaluate
//    call. `await page.evaluate(action)` followed by a separate
//    `page.evaluate(sampler)` measures nothing — a synchronously-blocking
//    action finishes blocking before a single frame is sampled, and gets
//    reported as smooth. `browser.close()` also lives in a `finally` here:
//    a throwing action (bad selector, bad page) must not leak the Chromium
//    process, or the caller (and `node --test`) hangs.
// 5. `fps` misreads in headless Chromium: it is not vsync-capped, so a smooth
//    run can read ~120 fps instead of ~60. `worstFrameMs` (and the derived
//    `jankFrames`/`jankPct`, frames over the 16.7ms/frame budget) are the
//    numbers that actually gate jank; `fps` is kept for reference only and
//    must not be read as "out of 60".
// 6. Browser mode had no noise floor at all, unlike Node mode's `measureNoise`
//    — it always exited 0, even on a machine too busy to trust. So
//    `measureFrames` now samples an idle frame-time baseline (`idleWorstFrameMs`)
//    on the page BEFORE the action fires. A bad idle floor means the machine
//    cannot support a trustworthy frame measurement, and this refuses (throws,
//    non-zero exit on the CLI) exactly as Node mode does for a bad event-loop
//    noise floor. `worstFrameMs` sitting close to the noise is also why the
//    browser test gates on `jankFrames`/`jankPct` (a clean 0%-vs-~98% split)
//    rather than a `worstFrameMs` threshold near the noise band — see
//    skill/test/measure-browser.test.mjs.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const SAMPLE_MS = 5;
const SETTLE_TICKS = 4;
const NOISE_THRESHOLD_MS = 20;
const BROWSER_IDLE_SAMPLE_MS = 500;
const BROWSER_NOISE_THRESHOLD_MS = 30;

/**
 * Start sampling event-loop lag on an interval. Returns a handle with
 * `worst()` (the worst lag observed so far) and `stop()` (clears the timer).
 * Shared by `measureNoise` and `measureBlocking` — both need the exact same
 * sampler; only what happens around it (and how long it settles) differs.
 */
function startLagSampler() {
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - SAMPLE_MS);
    last = now;
  }, SAMPLE_MS);
  return {
    worst: () => worst,
    stop: () => clearInterval(timer),
  };
}

/** Worst idle event-loop lag over `ms`. The machine's noise floor. */
export async function measureNoise(ms = 300) {
  const sampler = startLagSampler();
  await new Promise((res) => setTimeout(res, ms));
  sampler.stop();
  return Math.max(0, Math.round(sampler.worst()));
}

/**
 * Run `run()` while sampling event-loop lag on the main thread. Brackets the
 * run with a noise-floor reading before and after (hazard 2 above), so the
 * caller can tell a real block from a contaminated machine.
 * @param {() => unknown | Promise<unknown>} run
 * @returns {Promise<{wallMs: number, worstBlockMs: number, value: unknown, noiseBeforeMs: number, noiseAfterMs: number}>}
 */
export async function measureBlocking(run) {
  const noiseBeforeMs = await measureNoise(300);

  const sampler = startLagSampler();
  const t0 = performance.now();
  let value;
  let wallMs;
  try {
    value = await run();
    wallMs = performance.now() - t0;
  } finally {
    // Settle: let the delayed tick that carries the real lag actually land.
    // This MUST run, and the sampler MUST be stopped, even if `run()` threw —
    // every candidate this gate vets is arbitrary CPU code, and a throw is
    // routine. Skipping either leaks the interval and the process hangs.
    for (let i = 0; i < SETTLE_TICKS; i++) {
      await new Promise((res) => setTimeout(res, SAMPLE_MS));
    }
    sampler.stop();
  }

  const worstBlockMs = Math.max(0, Math.round(sampler.worst()));
  const noiseAfterMs = await measureNoise(300);

  return {
    wallMs: Math.round(wallMs),
    worstBlockMs,
    value,
    noiseBeforeMs,
    noiseAfterMs,
  };
}

/**
 * Sample frame times in the page for `ms`, optionally firing `action` (fire
 * and forget, never awaited) after the rAF sampler is armed. Shared by the
 * idle noise-floor sample and the real action sample below — both need the
 * exact same in-page sampler; only what fires (nothing, vs. the action) and
 * how the result is used differs.
 *
 * Ordering is load-bearing when `action` is given: the rAF sampler MUST be
 * armed and the action MUST be fired inside this ONE `page.evaluate` call,
 * sampler first. Two separate `evaluate` calls (sampler installed only after
 * awaiting the action) would let a synchronously-blocking action finish
 * blocking before a single frame was sampled, and it would be reported as
 * smooth — the worst possible defect for a gate whose entire job is proving
 * the main thread was freed.
 */
async function sampleFrameTimes(page, { action = "", ms }) {
  return page.evaluate(async ({ action, ms }) => {
    // rAF-driven: a CSS animation would keep running on the compositor while the
    // main thread is blocked, and would hide exactly the jank we are looking for.
    // Armed BEFORE the action fires — see the ordering note above.
    const dts = [];
    let last = performance.now();
    let stop = false;
    requestAnimationFrame(function loop(t) {
      dts.push(t - last);
      last = t;
      if (!stop) requestAnimationFrame(loop);
    });

    // Fire, don't await. A synchronous throw (bad selector) is left
    // uncaught here on purpose, so it propagates out of this evaluate()
    // and fails the measurement loudly. A returned promise that rejects
    // later (async workload) is caught so it doesn't become an unhandled
    // rejection in the page — it is still never awaited.
    if (action) {
      const maybePromise = new Function(action)();
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.catch(() => {});
      }
    }

    await new Promise((r) => setTimeout(r, ms));
    // Settle: after a stall Chromium dispatches the queued frame with a stale
    // timestamp, and only the NEXT frame carries the real jump.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    stop = true;
    return dts;
  }, { action, ms });
}

/**
 * Sample main-thread frame times in a real browser while `action` runs.
 * Playwright is an optional dependency — absent, this reports and gives up.
 *
 * Before navigating to `url` at all, this samples an IDLE frame-time
 * baseline (`idleWorstFrameMs`) on the browser's blank starting page —
 * Node mode's `measureBlocking` has the same idea with `measureNoise` before
 * the run. Deliberately sampled BEFORE `page.goto(url)`, not after: this
 * repo's own demo page starts its main-thread workload immediately on load
 * ("land on the bad case, so one click shows the difference" — see
 * demo/index.html), so sampling idle frames on the already-loaded page would
 * measure the demo's own by-design workload, not whether the machine is
 * busy. A blank pre-navigation page has no such confound. If the idle floor
 * is itself bad (over `BROWSER_NOISE_THRESHOLD_MS`), the machine cannot
 * support a trustworthy frame measurement — another tab, a background build,
 * thermal throttling — so this REFUSES (throws) rather than hand back a
 * number, the same posture as Node mode's noise-floor refusal. There is no
 * matching "after" floor here: unlike Node mode's callable, the action is
 * fire-and-forget and workloads under test may run forever by design, so
 * there is no point after the action where the page is idle again to
 * re-sample.
 *
 * The action is fired but never awaited — this repo's demo workloads loop
 * forever by design, so awaiting them would hang forever. A synchronous
 * throw (e.g. a bad selector) is left to propagate, which fails the
 * `page.evaluate` call and this function's returned promise (see the
 * `finally`/`browser.close()` below); a later *async* rejection from a
 * returned promise is swallowed so it doesn't surface as an unhandled
 * rejection in the page.
 *
 * `browser.close()` runs in a `finally` so a bad URL, a throwing action, a
 * refused idle floor, or a sampler failure never leaks the Chromium process —
 * a leak would hang the caller (and hang `node --test` after the assertions
 * already ran).
 *
 * `fps` is not a reliable jank signal here: headless Chromium is not
 * vsync-capped, so a smooth run can read ~120 fps rather than ~60. Prefer
 * `worstFrameMs` and `jankFrames`/`jankPct` (frames over the 16.7ms budget) —
 * and prefer `jankFrames`/`jankPct` over `worstFrameMs` for pass/fail gating,
 * since a single worst-frame reading can sit close to the noise floor while
 * the jank percentage separates cleanly (0% vs. ~98%, in this repo's demo).
 * @param {string} url
 * @param {{action?: string, seconds?: number}} opts
 * @returns {Promise<{worstFrameMs: number, jankFrames: number, jankPct: number, totalFrames: number, fps: number, idleWorstFrameMs: number}>}
 */
export async function measureFrames(url, { action = "", seconds = 4 } = {}) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error(
      "browser mode needs playwright: npm i -D playwright && npx playwright install chromium",
    );
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    // Idle floor FIRST, on the blank page, BEFORE navigating anywhere near
    // `url` — see the "Deliberately sampled BEFORE page.goto" note above.
    const idleDts = await sampleFrameTimes(page, { ms: BROWSER_IDLE_SAMPLE_MS });
    const idleWorstFrameMs = idleDts.length ? Math.round(Math.max(...idleDts)) : 0;
    if (idleWorstFrameMs > BROWSER_NOISE_THRESHOLD_MS) {
      throw new Error(
        `REFUSED  machine was busy (idle worst frame ${idleWorstFrameMs}ms, over the ` +
          `${BROWSER_NOISE_THRESHOLD_MS}ms threshold). Close other tabs/workloads and re-run. ` +
          `A busy machine gives wrong numbers.`,
      );
    }

    await page.goto(url);
    const dts = await sampleFrameTimes(page, { action, ms: seconds * 1000 });

    const totalFrames = dts.length;
    const worstFrameMs = totalFrames ? Math.round(Math.max(...dts)) : 0;
    const jankFrames = dts.filter((d) => d > 16.7).length;
    const jankPct = totalFrames ? Math.round((jankFrames / totalFrames) * 1000) / 10 : 0;
    const fps = Math.round(totalFrames / seconds);
    return { worstFrameMs, jankFrames, jankPct, totalFrames, fps, idleWorstFrameMs };
  } finally {
    await browser.close();
  }
}

// CLI: node measure.mjs path/to/mod.mjs#exportName '[40]'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--browser") {
    const url = process.argv[3];
    const actionIdx = process.argv.indexOf("--action");
    const secondsIdx = process.argv.indexOf("--seconds");
    const action = actionIdx > -1 ? process.argv[actionIdx + 1] : "";
    const seconds = secondsIdx > -1 ? Number(process.argv[secondsIdx + 1]) : 4;
    let r;
    try {
      r = await measureFrames(url, { action, seconds });
    } catch (err) {
      // Refusal (bad idle noise floor) and any other measurement failure
      // (missing playwright, a throwing action) all land here — non-zero
      // exit, same posture as Node mode's noise-floor refusal.
      console.error(err?.message ?? String(err));
      process.exit(2);
    }
    console.log(`idle worst frame ${r.idleWorstFrameMs} ms   (sampled before the action fired — this browser's noise floor)`);
    console.log(`worst frame    ${r.worstFrameMs} ms   ${r.worstFrameMs > 16.7 ? "<- dropped frames" : "(within budget)"}`);
    console.log(`jank frames    ${r.jankFrames}/${r.totalFrames} (${r.jankPct}%)   frames over the 16.7ms budget`);
    console.log(`fps            ${r.fps}   (uncapped in headless Chromium — not vsync-limited, don't compare to 60)`);
    process.exit(0);
  }
  const [target, argsJson = "[]"] = process.argv.slice(2);
  if (!target) {
    console.error("usage: measure.mjs <file.mjs#exportName> [argsJson]");
    process.exit(2);
  }
  const [file, name = "default"] = target.split("#");
  const mod = await import(pathToFileURL(resolve(file)).href);
  const fn = mod[name];
  if (typeof fn !== "function") {
    console.error(`measure: ${target} is not a function (got ${typeof fn})`);
    process.exit(2);
  }
  const args = JSON.parse(argsJson);
  const r = await measureBlocking(() => fn(...args));

  // A measurement must never be shown without the context that says whether
  // to believe it: both noise floors are always printed alongside the number.
  console.log(`noise floor (before) ${r.noiseBeforeMs} ms`);
  console.log(`noise floor (after)  ${r.noiseAfterMs} ms`);
  console.log(`wall clock           ${r.wallMs} ms`);
  console.log(`main-thread block    ${r.worstBlockMs} ms   ${r.worstBlockMs > 16 ? "<- blocks the main thread" : "(under one frame)"}`);

  if (r.noiseBeforeMs > NOISE_THRESHOLD_MS || r.noiseAfterMs > NOISE_THRESHOLD_MS) {
    console.error(
      `REFUSED  machine was busy (before=${r.noiseBeforeMs}ms, after=${r.noiseAfterMs}ms idle event-loop lag).`
    );
    console.error(`         Close other workloads and re-run. A busy machine gives wrong numbers.`);
    process.exit(2);
  }
}
