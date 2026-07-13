// Copies the built bundle into the skill so the skill is self-contained.
// The skill is useless if this drifts from the library, so it is a build step,
// never a hand-copy. `npm run build` runs it.
import { copyFile, mkdir } from "node:fs/promises";

const SRC = new URL("../dist/unithread.bundle.js", import.meta.url);
const DEST = new URL("../skill/assets/unithread.bundle.js", import.meta.url);

await mkdir(new URL("./", DEST), { recursive: true });
await copyFile(SRC, DEST);
console.log("synced skill/assets/unithread.bundle.js <- dist/unithread.bundle.js");
