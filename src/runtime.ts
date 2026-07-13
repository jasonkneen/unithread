/** Runtime detection. One place, so every other module branches identically. */

export const isNode: boolean =
  typeof process !== "undefined" &&
  !!(process as any).versions?.node &&
  typeof (globalThis as any).importScripts === "undefined" &&
  typeof (globalThis as any).window === "undefined";

/** Number of hardware threads available to this runtime. */
export async function hardwareConcurrency(): Promise<number> {
  if (isNode) {
    const os = await import("node:os");
    return (os.availableParallelism?.() ?? os.cpus().length) || 1;
  }
  return (globalThis as any).navigator?.hardwareConcurrency || 4;
}

/** True when SharedArrayBuffer is usable (browser requires cross-origin isolation). */
export function hasSharedMemory(): boolean {
  return typeof SharedArrayBuffer !== "undefined";
}
