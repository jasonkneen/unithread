// Serves the repo with cross-origin isolation headers and runs the browser
// proof suite in real Chromium, gating on the in-page verdict object.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };

const server = createServer(async (req, res) => {
  try {
    const path = normalize(join(ROOT, req.url === "/" ? "demo/index.html" : req.url));
    if (!path.startsWith(ROOT)) throw new Error("traversal");
    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
      // The two headers that unlock SharedArrayBuffer in browsers:
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
console.log(`serving http://localhost:${port} with COOP/COEP`);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("console.error:", m.text()); });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`http://localhost:${port}/demo/index.html`);
// The page starts a live workload on load; __runProofs() stops it and runs the
// suite on a quiet main thread.
await page.evaluate(() => window.__runProofs());
const result = await page.waitForFunction(() => window.__UNITHREAD_RESULT__, null, { timeout: 30000 })
  .then((h) => h.jsonValue());
await browser.close();
server.close();

for (const line of result.results) console.log(line);
console.log(`browser: ${result.pass} passed, ${result.fail} failed`);
console.log(`VERDICT: ${result.verdict}`);
process.exit(result.verdict === "PASS" ? 0 : 1);
