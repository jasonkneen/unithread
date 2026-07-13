// Static server for the demo. The two COOP/COEP headers are what unlock
// SharedArrayBuffer in browsers; without them the shared-memory proofs skip.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8080);
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  const url = req.url === "/" ? "/demo/index.html" : req.url.split("?")[0];
  const path = normalize(join(ROOT, url));
  if (!path.startsWith(ROOT)) return res.writeHead(403).end("forbidden");
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`unithread demo → http://localhost:${PORT}`);
  console.log("serving with COOP/COEP (SharedArrayBuffer enabled)");
});
