#!/usr/bin/env node
// Gate 2 of the unithread skill: did the main thread actually get freed?
//
// Two hazards are designed around here, both learned the hard way in this repo:
//
// 1. A stall is observed LATE. While the main thread is blocked no timer can
//    fire; the tick carrying the real lag lands only once the block ends. Stop
//    sampling the moment the callable returns and you measure ~0ms during a
//    1.2s freeze. So we settle extra ticks before clearing the sampler.
// 2. A busy machine produces confident, wrong numbers. Measure the idle noise
//    first and refuse to report if the machine is not quiet.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const SAMPLE_MS = 5;
const SETTLE_TICKS = 4;

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
 * Run `run()` while sampling event-loop lag on the main thread.
 * @param {() => unknown | Promise<unknown>} run
 * @returns {Promise<{wallMs: number, worstBlockMs: number, value: unknown}>}
 */
export async function measureBlocking(run) {
  const sampler = startLagSampler();

  const t0 = performance.now();
  const value = await run();
  const wallMs = performance.now() - t0;

  // Settle: let the delayed tick that carries the real lag actually land.
  for (let i = 0; i < SETTLE_TICKS; i++) {
    await new Promise((res) => setTimeout(res, SAMPLE_MS));
  }
  sampler.stop();

  return { wallMs: Math.round(wallMs), worstBlockMs: Math.max(0, Math.round(sampler.worst())), value };
}

// CLI: node measure.mjs path/to/mod.mjs#exportName '[40]'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, argsJson = "[]"] = process.argv.slice(2);
  if (!target) {
    console.error("usage: measure.mjs <file.mjs#exportName> [argsJson]");
    process.exit(2);
  }
  const noise = await measureNoise(300);
  if (noise > 20) {
    console.error(`REFUSED  machine is busy (${noise}ms idle event-loop lag).`);
    console.error(`         Close other workloads and re-run. A busy machine gives wrong numbers.`);
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
  console.log(`noise floor    ${noise} ms`);
  console.log(`wall clock     ${r.wallMs} ms`);
  console.log(`main-thread block ${r.worstBlockMs} ms   ${r.worstBlockMs > 16 ? "<- blocks the main thread" : "(under one frame)"}`);
}
