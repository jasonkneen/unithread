import { Task } from "./spawn.js";

/** A service object turned into async remote calls, plus lifecycle. */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
} & { terminate(): Promise<void> };

/**
 * Comlink-style proxy over a service Task: `svc.method(a, b)` instead of
 * `task.call("method", [a, b])`.
 */
export function wrap<T extends Record<string, (...args: any[]) => any>>(
  task: Task<any[], any>,
): Remote<T> {
  return new Proxy(Object.create(null), {
    get(_t, prop: string | symbol) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then") return undefined; // never thenable
      if (prop === "terminate") return () => task.terminate();
      return (...args: any[]) => task.call(prop, args);
    },
  }) as Remote<T>;
}

/** Spawn a service and wrap it in one step. */
export async function spawnRemote<
  T extends Record<string, (...args: any[]) => any>,
>(methods: T): Promise<Remote<T>> {
  return wrap<T>(await Task.spawnService(methods));
}
