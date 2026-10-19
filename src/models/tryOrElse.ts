/**
 * Leaf helpers for "attempt, otherwise recover" call sites that cannot log:
 * bootstrap code that runs before the logger exists, and the error formatters
 * the logger itself depends on. The recovery callback receives the caught
 * error, so the failure is forwarded (never silently dropped) and the caller
 * decides whether it carries any signal. Must stay import-free so it can be
 * used from `logger`'s own dependencies.
 */
export function tryOrElse<T>(attempt: () => T, recover: (error: unknown) => T): T {
  try {
    return attempt();
  } catch (error) {
    return recover(error);
  }
}

export async function tryOrElseAsync<T>(
  attempt: () => Promise<T>,
  recover: (error: unknown) => T | Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    return recover(error);
  }
}
