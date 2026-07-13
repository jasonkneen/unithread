// Fixtures for the portability gate. Deliberately includes functions that
// look fine and are not.
const MULTIPLIER = 3; // captured from module scope — invisible across the boundary
const MULT = 7; // same trap, but guarded — see `sneaky` below

/** Self-contained: everything it needs arrives as an argument. */
export const portable = (n) => {
  const fib = (x) => (x < 2 ? x : fib(x - 1) + fib(x - 2));
  return fib(n);
};

/** Captures MULTIPLIER. Typechecks, lints, passes review, dies in a worker. */
export const capturesModuleConst = (n) => n * MULTIPLIER;

/** Captures a browser global that does not exist in a worker. */
export const capturesDomGlobal = () => document.title;

/** Self-contained and async. */
export const portableAsync = async (n) => n * 2;

/**
 * Captures MULT, but guards the reference with `typeof`, so it never throws
 * in the worker (MULT is simply "undefined" there) — it just silently takes
 * the other branch and returns a different, wrong number. A gate that only
 * asks "did it throw?" reports this as portable. It is not: the result
 * diverges (35 vs 5 for n=5).
 */
export const sneaky = (n) => (typeof MULT !== "undefined" ? n * MULT : n);

/**
 * Throws its own plain Error whose message reads exactly like a leaked
 * identifier ("5 is not defined") — the same shape the leaked-identifier
 * regex matches. But it is a plain Error, not a ReferenceError: nothing was
 * captured, the function raised this on purpose. This must be diagnosed as
 * `reason: "threw"` (the candidate's own business), never `reason: "captured"`,
 * and `leaked` must be null despite the message matching the pattern.
 */
export const throwsOwnError = (n) => {
  throw new Error(`${n} is not defined`);
};

/**
 * Self-contained but non-deterministic. Portable in the sense that matters
 * (no captures), but comparing main-thread vs. worker results will
 * legitimately disagree — this is what `{ compare: false }` / `--no-compare`
 * is for.
 */
export const nonDeterministic = () => Math.random();
