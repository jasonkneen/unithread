#!/usr/bin/env node
// Gate 1 of the unithread skill: does this function survive the thread boundary?
//
// Shipped functions cross via Function.prototype.toString(), so anything they
// captured from an enclosing scope is simply absent on the other side. That
// failure is invisible to the typechecker and the linter. So we do not model it
// — we provoke it: spawn the function in a real worker and see what happens.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Task } from "../assets/unithread.bundle.js";

const NOT_DEFINED = /\b(\w+) is not defined\b/;

/**
 * @param {Function} fn   candidate to ship to a worker
 * @param {unknown[]} args sample args — must exercise the code path under test
 * @returns {Promise<{ok: boolean, value?: unknown, leaked: string|null, error: string|null}>}
 */
export async function verifyPortable(fn, args = []) {
  let task;
  try {
    task = await Task.spawn(fn);
    const value = await task.run(args);
    return { ok: true, value, leaked: null, error: null };
  } catch (err) {
    const message = err?.message ?? String(err);
    const match = NOT_DEFINED.exec(message);
    return { ok: false, leaked: match ? match[1] : null, error: message };
  } finally {
    await task?.terminate();
  }
}

// NOTE on coverage: this gate only exercises the branches that `args` actually
// take. A capture guarded by a condition the sample args never trigger (e.g.
// `if (rareCase) return someModuleScopedThing;`) will not throw here and will
// be reported as portable even though it is not. This is a runtime probe, not
// a static guarantee — pass args that cover the paths you care about.

// CLI: node verify-portable.mjs path/to/mod.mjs#exportName '[10]'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, argsJson = "[]"] = process.argv.slice(2);
  if (!target) {
    console.error("usage: verify-portable.mjs <file.mjs#exportName> [argsJson]");
    process.exit(2);
  }
  const [file, name = "default"] = target.split("#");
  const mod = await import(pathToFileURL(resolve(file)).href);
  const fn = mod[name];
  if (typeof fn !== "function") {
    console.error(`FAIL  ${target} is not a function (got ${typeof fn})`);
    process.exit(2);
  }
  const r = await verifyPortable(fn, JSON.parse(argsJson));
  if (r.ok) {
    console.log(`PASS  portable — worker returned ${JSON.stringify(r.value)}`);
    process.exit(0);
  }
  if (r.leaked) {
    console.error(`FAIL  not portable — "${r.leaked}" was captured from the enclosing scope.`);
    console.error(`      It does not exist inside the worker. Pass it as an argument instead.`);
  } else {
    console.error(`FAIL  worker threw: ${r.error}`);
  }
  process.exit(1);
}
