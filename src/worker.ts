import { isNode } from "./runtime.js";

export type Transferable_ = ArrayBuffer | MessagePort;
export type MessageHandler = (data: any) => void;

/**
 * A single API over `node:worker_threads.Worker` and the browser `Worker`.
 * Always constructed from a JS source *string* (the portable common ground:
 * Node uses `{ eval: true }`, browsers use a Blob URL).
 */
export class UnifiedWorker {
  private constructor(
    private readonly impl: any,
    private readonly kind: "node" | "web",
    private readonly blobUrl?: string,
  ) {}

  /** Spawn a real OS thread running `source` (classic script, both runtimes). */
  static async fromSource(source: string): Promise<UnifiedWorker> {
    if (isNode) {
      const { Worker } = await import("node:worker_threads");
      return new UnifiedWorker(new Worker(source, { eval: true }), "node");
    }
    const url = URL.createObjectURL(
      new Blob([source], { type: "text/javascript" }),
    );
    return new UnifiedWorker(new (globalThis as any).Worker(url), "web", url);
  }

  postMessage(data: any, transfer: Transferable_[] = []): void {
    if (this.kind === "node") this.impl.postMessage(data, transfer);
    else this.impl.postMessage(data, transfer);
  }

  onMessage(cb: MessageHandler): void {
    if (this.kind === "node") this.impl.on("message", cb);
    else this.impl.addEventListener("message", (e: any) => cb(e.data));
  }

  onError(cb: (err: unknown) => void): void {
    if (this.kind === "node") this.impl.on("error", cb);
    else this.impl.addEventListener("error", (e: any) => cb(e.error ?? e.message ?? e));
  }

  async terminate(): Promise<void> {
    if (this.kind === "node") await this.impl.terminate();
    else {
      this.impl.terminate();
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    }
  }
}
