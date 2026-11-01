import { prototypeFieldsOfKind } from "./prototypeEmitContext";
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

/** The root window direction is independent of system window controls. */
export function prototypeLayoutDirectionFields(spec: unknown): string[] {
  return record(record(spec)?.window)?.layoutDirection !== undefined
    ? ["window.layoutDirection"]
    : [];
}

/** Every `hideKeyboard` action (#14320), gated by prototype_hide_keyboard_v1. */
export function prototypeHideKeyboardFields(spec: unknown): string[] {
  return prototypeFieldsOfKind(spec, "hideKeyboard");
}
