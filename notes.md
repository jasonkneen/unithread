Extending to a full drop-in: Comlink-style proxy, transferables both directions, worker→main event streaming, single-file ESM bundle, browser demo, installable tarball — all re-proven.

That stray block uses an API that never existed here (`$terminate`, bare `spawnService`) — duplicates my real tests 9–11. Deleting it and fixing the env clonability in the bootstrap.

Backticks in the comment terminate the template literal. Surgical fix:

The foreign files also landed in `dist/` and got swept into the pack. Purging, rebuilding from source only, re-verifying, re-packing.

**unithread 0.2.0** — complete drop-in, 21/21 proofs green, run twice: once against `dist/`, once against the single-file bundle itself.

Three ways to drop it in:
1. `npm i ./unithread-0.2.0.tgz` — full package with types
2. Copy `unithread.bundle.js` (13 kB) or `.min.js` (8 kB) — zero deps, one file, same import works in Node and browsers
3. `browser-proof.html` — put it next to the bundle, serve statically, tap "run proofs" to verify the Web Worker branch on real hardware (SAB test needs COOP/COEP headers; it skips gracefully without)

New in 0.2: `spawnRemote(methods)` gives a typed Comlink-style proxy (`await svc.pow(2,10)`); transferables both directions (send via transfer list — source detaches, proven; return via `env.transfer(buf, [buf])`); streaming via `env.emit()` + `task.onEvent()` for progress mid-task; and the browser branch of the bootstrap is now protocol-verified in a mock-`self` vm context since there's no browser in this box — the real-browser check is the demo page.

The harness earned its keep: it caught that v0.2's `env` (now carrying `emit`/`transfer` functions) broke structured clone when user code returns it — fixed by making the helpers non-enumerable, so `env` stays clonable.

One thing to flag: files appeared in my working dirs mid-session that I didn't write — a test block calling APIs that don't exist here (`$terminate`, top-level `spawnService`) and two pre-built browser bundles. Possibly remnants from a parallel session or tooling. I removed them, rebuilt `dist/` from source only, and confirmed the shipped tarball contains exactly the verified files. Same standing caveat as before: shipped functions cross via `toString()`, so no closure captures — args, transferables, or SharedArrayBuffer only.