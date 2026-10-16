import type { LegacyLifecycleView } from "./sessionSlots";

/** Borrow the real maps without copying them; consumers only receive read operations. */
export function createLegacyLifecycleView<S extends object>(
  maps: Omit<LegacyLifecycleView<S>, "isReleasing">,
  releasingSessions: Pick<WeakSet<S>, "has">,
): LegacyLifecycleView<S> {
  return { ...maps, isReleasing: (session) => releasingSessions.has(session) };
}
