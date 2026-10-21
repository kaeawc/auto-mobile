import { zodToJsonSchema } from "zod-to-json-schema";
import { stripInternalToolParams } from "./internalToolParams";
import {
  deviceConditionInputSchema,
  type DeviceConditionInput,
} from "../features/deviceCondition/DeviceConditionTypes";

/**
 * Human description of the embedded `deviceCondition` field. Kept here, not inline
 * in the large `setDeviceState` schema, only to keep that file under its line cap;
 * the field itself stays an inline `z.unknown()` there so the parent inference does
 * not degrade (an external schema const re-degrades it; a plain string does not).
 */
export const DEVICE_CONDITION_FIELD_DESCRIPTION =
  "Session-scoped root/integrity/fault test fixtures (behind the 'device-condition' feature flag). " +
  "Every applied condition restores to a clean state on release, rebind or lease expiry. Send it in " +
  "its own call, not combined with other setDeviceState fields.";

/**
 * `deviceCondition` is embedded in `setDeviceState` as a bare `z.unknown()` field,
 * because its rich zod type — even wrapped in a `superRefine`, the way the
 * `prototype` tool embeds its spec — degrades the large parent schema's inference
 * to `unknown` (tsgo instantiation limit). So the real contract lives here: this
 * module advertises it on the JSON schema and validates it in the handler, rather
 * than at the zod boundary.
 */
const advertisedDeviceCondition = ((): Record<string, unknown> => {
  const schema = zodToJsonSchema(deviceConditionInputSchema, {
    strictUnions: true,
    pipeStrategy: "input",
  }) as Record<string, unknown>;
  // A nested property carries no `$schema` dialect declaration.
  delete schema.$schema;
  return schema;
})();

/** Replace the embedded field's permissive `{}` JSON schema with the real contract. */
export function applyDeviceConditionJsonSchema(
  properties: Record<string, Record<string, unknown>> | undefined,
): void {
  if (properties?.deviceCondition) {
    Object.assign(properties.deviceCondition, advertisedDeviceCondition);
  }
}

export type DeviceConditionParseResult =
  | { ok: true; value: DeviceConditionInput }
  | { ok: false; error: string };

/** Validate an embedded `deviceCondition` value and format failures for the handler. */
export function parseDeviceConditionInput(value: unknown): DeviceConditionParseResult {
  const parsed = deviceConditionInputSchema.safeParse(stripInternalToolParams(value));
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const error = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "deviceCondition"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error };
}
