import { AsyncLocalStorage } from "node:async_hooks";
import { isDevicePoolAutolockEnabled, type Environment } from "./poolConfig";

const operationAutolock = new AsyncLocalStorage<boolean>();

/** Standalone acquisitions/access checks have no enclosing tool snapshot. */
export function captureAutolockPolicy(env: Environment = process.env): boolean {
  return operationAutolock.getStore() ?? isDevicePoolAutolockEnabled(env);
}

/** Carry policy across the unchanged tool-handler interface; nested work inherits it. */
export function runWithAutolockPolicy<T>(env: Environment | undefined, operation: () => T): T {
  return operationAutolock.run(captureAutolockPolicy(env), operation);
}
