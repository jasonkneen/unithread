import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const ROOT = new URL("../../", import.meta.url);

test("vendored asset is byte-identical to the built bundle", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "unithread-asset-test-"));
  const freshOutfile = join(tmpDir, "unithread.bundle.js");
  try {
    // Build straight from current source, matching the "bundle" script in
    // package.json exactly: entry src/index.ts, --bundle --format=esm
    // --platform=neutral --external:node:*. Output goes to a scratch temp
    // file so this test never touches dist/ or skill/assets/ — rebuilding
    // in place would repair drift instead of detecting it.
    await build({
      entryPoints: [fileURLToPath(new URL("src/index.ts", ROOT))],
      bundle: true,
      format: "esm",
      platform: "neutral",
      external: ["node:*"],
      outfile: freshOutfile,
    });

    const fresh = await readFile(freshOutfile);
    const vendored = await readFile(new URL("skill/assets/unithread.bundle.js", ROOT));
    assert.equal(
      sha(vendored),
      sha(fresh),
      "vendored asset does not match a bundle built from current src/ — run `npm run build`",
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("vendored asset is importable and exports the public API", async () => {
  const m = await import(new URL("skill/assets/unithread.bundle.js", ROOT).href);
  for (const name of ["runInThread", "Task", "WorkerPool", "spawnRemote", "SharedCounter", "Mutex", "Signal"]) {
    assert.equal(typeof m[name], "function", `missing export: ${name}`);
  }
});
