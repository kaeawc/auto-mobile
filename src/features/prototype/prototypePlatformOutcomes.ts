import { z } from "zod/v4";
import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_PLATFORM_OUTCOMES_CAPABILITY } from "../observe/android/ctrlProxyProtocol/capabilities";
import { prototypeJsonSchema, type PrototypeJson } from "./prototypeJson";
import { PROTOTYPE_PLATFORM_ERROR_CODES, prototypePlatformCall } from "./prototypePlatform";

export const prototypePlatformOutcomeSchema = z.union([
  z.strictObject({
    result: z.unknown().nonoptional(),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum(PROTOTYPE_PLATFORM_ERROR_CODES),
      message: z.string().max(200).optional(),
    }),
  }),
]);

export type PrototypePlatformOutcome =
  | { result: PrototypeJson }
  | Extract<z.output<typeof prototypePlatformOutcomeSchema>, { error: unknown }>;

type OutcomeValidation =
  | { outcome: PrototypePlatformOutcome; issue?: never }
  | { issue: [string, string]; outcome?: never };

export function validatePrototypePlatformOutcome(
  call: string,
  outcome: unknown,
): OutcomeValidation {
  if (!prototypePlatformCall(call)) {
    return {
      issue: [
        "call",
        `Unknown platform call "${call}". Use a known <module>.<call> from the prototype contract.`,
      ],
    };
  }
  const parsed = prototypePlatformOutcomeSchema.safeParse(outcome);
  if (!parsed.success) {
    return {
      issue: [
        "outcome",
        "Provide exactly one JSON result or an error with a platform error code and optional message of at most 200 characters",
      ],
    };
  }
  let validated: PrototypePlatformOutcome;
  if ("result" in parsed.data) {
    const result = prototypeJsonSchema.safeParse(parsed.data.result);
    if (!result.success) {
      return { issue: ["outcome", "simulate result must be a JSON value"] };
    }
    validated = { result: result.data };
  } else {
    validated = parsed.data;
  }
  if (
    Buffer.byteLength(JSON.stringify(validated), "utf8") >
    contract.limits.MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES
  ) {
    return { issue: ["outcome", "simulate outcome exceeds the 4096-byte emit budget"] };
  }
  return { outcome: validated };
}

export function prototypePlatformOutcomesUnsupportedMessage(): string {
  return `simulate: queued call outcomes require the connected prototype runtime advertising ${PROTOTYPE_PLATFORM_OUTCOMES_CAPABILITY}. Update the runtime and use a module that supports simulation (debug test.echo).`;
}
