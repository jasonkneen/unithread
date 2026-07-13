import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const ROOT = new URL("../../", import.meta.url);

test("vendored asset is byte-identical to the built bundle", async () => {
  const built = await readFile(new URL("dist/unithread.bundle.js", ROOT));
  const vendored = await readFile(new URL("skill/assets/unithread.bundle.js", ROOT));
  assert.equal(sha(vendored), sha(built), "run `npm run skill:sync` — the vendored bundle is stale");
});

test("vendored asset is importable and exports the public API", async () => {
  const m = await import(new URL("skill/assets/unithread.bundle.js", ROOT).href);
  for (const name of ["runInThread", "Task", "WorkerPool", "spawnRemote", "SharedCounter", "Mutex", "Signal"]) {
    assert.equal(typeof m[name], "function", `missing export: ${name}`);
  }
});
