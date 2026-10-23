/**
 * Memoizes selected read methods of single-process test doubles until anything else is called on
 * any double wrapped by the same cache.
 *
 * The broker's ownership fence re-reads the same binding row, journal and resource before and
 * after every adb command of a reset: hundreds of identical SQLite round trips per release. With
 * one thread and no external writer, a read can only change after a non-read call, so each such
 * call on any wrapped double opens a new epoch (the registry and the store share one database).
 * Cached values are deep-frozen copies, so a caller that mutated one would throw instead of
 * corrupting a later read.
 */
export function createEpochReadCache(): {
  wrap<T extends object>(target: T, cachedReads: readonly (keyof T & string)[]): T;
} {
  let epoch = 0;
  let nextIdentity = 0;
  const identities = new WeakMap<object, number>();
  const identity = (object: object): number => {
    let id = identities.get(object);
    if (id === undefined) {
      id = nextIdentity++;
      identities.set(object, id);
    }
    return id;
  };
  const cache = new Map<string, { epoch: number; value: unknown }>();
  return {
    wrap<T extends object>(target: T, cachedReads: readonly (keyof T & string)[]): T {
      const cached = new Set<string>(cachedReads);
      return new Proxy(target, {
        get(object, property, receiver) {
          const member: unknown = Reflect.get(object, property, receiver);
          if (typeof member !== "function" || typeof property !== "string") {
            return member;
          }
          if (!cached.has(property)) {
            return (...args: unknown[]) => {
              epoch++;
              return Reflect.apply(member, object, args);
            };
          }
          return async (...args: unknown[]) => {
            const key = `${identity(object)}:${property}:${JSON.stringify(args)}`;
            const hit = cache.get(key);
            if (hit?.epoch === epoch) {
              return hit.value;
            }
            const readEpoch = epoch;
            const value: unknown = await Reflect.apply(member, object, args);
            if (readEpoch === epoch) {
              cache.set(key, { epoch, value: deepFreeze(structuredClone(value)) });
            }
            return value;
          };
        },
      });
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
