import { spyOn } from "bun:test";

/** Spy on a private/protected method, which `spyOn`'s public-key typing excludes. */
export function spyOnPrivate<Args extends unknown[] = unknown[], Result = Promise<void>>(
  target: object,
  method: string,
) {
  return spyOn(target as Record<string, (...args: Args) => Result>, method);
}
