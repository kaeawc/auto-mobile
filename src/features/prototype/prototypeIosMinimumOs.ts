/**
 * Minimum iOS major version for each prototype capability whose renderer needs a runtime newer than
 * the package floor (iOS 17), so a refusal can say which iOS the device needs (#15242). The iOS
 * agent advertises a capability only on an OS at or above its entry; the same table lives in
 * `PrototypeCapabilityMinimumOS` (Swift) and `prototypeIosMinimumOs.test.ts` fails when they drift.
 * A capability absent from the table runs on the floor.
 */
export const PROTOTYPE_IOS_MINIMUM_OS: Readonly<Record<string, number>> = {
  prototype_platform_namespace_v1: 17,
  prototype_icon_effects_v1: 17,
  prototype_keyframes_v1: 17,
  prototype_zoom_transition_v1: 18,
};

/** Sentence appended to an iOS refusal when the capability needs a newer iOS, else "". */
export function prototypeIosMinimumOsNote(
  capability: string,
  minimumOs: Readonly<Record<string, number>> = PROTOTYPE_IOS_MINIMUM_OS,
): string {
  const major = minimumOs[capability];
  return major === undefined ? "" : ` It needs iOS ${major} or later.`;
}
