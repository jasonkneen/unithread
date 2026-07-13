// Fixtures for the portability gate. Deliberately includes a function that
// looks fine and is not.
const MULTIPLIER = 3; // captured from module scope — invisible across the boundary

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
