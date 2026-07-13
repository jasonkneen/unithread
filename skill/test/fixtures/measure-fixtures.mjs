// Fixtures dedicated to skill/scripts/measure.mjs's own tests (Gate 2). Kept
// separate from fixtures/candidates.mjs, which belongs to the portability
// gate (verify-portable.mjs), so the two gates' fixtures don't get coupled.

/** Trivial, fast, self-contained — used for CLI smoke tests. */
export const quick = (n) => n + 1;

/**
 * Returns immediately, but schedules CPU-blocking work 50ms later — after
 * measureBlocking's settle loop (~20ms) has finished, so the busy-wait lands
 * inside the post-run noise-floor window instead of being picked up as part
 * of the measured block itself. Used to prove the after-check catches
 * contention that only starts once run() has already returned — exactly the
 * gap the pre-run-only check used to miss.
 */
export const noisyAfterReturn = () => {
  setTimeout(() => {
    const end = performance.now() + 200;
    while (performance.now() < end) {
      // busy-wait, deliberately
    }
  }, 50);
  return "ok";
};
