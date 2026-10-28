import { record } from "./prototypeTemplate";

/** The root `window` controls (#14320) gated by prototype_platform_window_controls_v1. */
export const PROTOTYPE_WINDOW_CONTROL_FIELDS = [
  "keepScreenOn",
  "brightness",
  "orientation",
  "statusBar",
] as const;

/** The `window.<control>` paths a spec sets, in contract order. */
export function prototypeWindowControlFields(spec: unknown): string[] {
  const window = record(record(spec)?.window);
  return PROTOTYPE_WINDOW_CONTROL_FIELDS.filter((field) => window?.[field] !== undefined).map(
    (field) => `window.${field}`,
  );
}
