import { extname, isAbsolute } from "node:path";
import { z } from "zod/v4";
import type {
  PrototypePlatformOutcomeRequest,
  QueuePrototypeCallOutcomeMessage,
} from "../observe/android/ctrlProxyProtocol/prototypeMessages";
import { ctrlProxyRequests } from "../observe/android/ctrlProxyProtocol/requestBuilders";
import { ActionableError } from "../../models/ActionableError";
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

/**
 * System picker and camera calls (#14197) whose result the device builds from host media files.
 * A simulated result names those files; turning them into media items needs device media
 * injection (#14192), which no runtime has yet, so a well-formed result is refused with that
 * reason and a malformed one with its shape. Errors such as `cancelled` pass unchanged.
 */
const MEDIA_FILE_CALLS: Readonly<Record<string, { maxFiles: number }>> = {
  "mediaLibrary.pick": { maxFiles: 64 },
  "camera.capture": { maxFiles: 1 },
};
const MEDIA_FILE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm"];

function mediaFilesResultIssue(call: string, result: unknown): string | undefined {
  const rule = MEDIA_FILE_CALLS[call];
  if (rule === undefined) {
    return undefined;
  }
  const files = z
    .strictObject({ files: z.array(z.string().max(4096)).min(1).max(rule.maxFiles) })
    .safeParse(result);
  const count = rule.maxFiles === 1 ? "exactly one" : `1 to ${rule.maxFiles}`;
  if (
    !files.success ||
    !files.data.files.every(
      (path) => isAbsolute(path) && MEDIA_FILE_EXTENSIONS.includes(extname(path).toLowerCase()),
    )
  ) {
    return `A ${call} result is {files: [...]} with ${count} absolute path(s) to ${MEDIA_FILE_EXTENSIONS.join(", ")} files. To simulate a cancel, use {error: {code: "cancelled"}}.`;
  }
  return `A simulated ${call} result needs device media injection, which no connected runtime supports yet, so it cannot be queued. Simulate a cancel or failure with {error: {code: "cancelled"}} instead.`;
}

/**
 * A queued `share.open` result (#19308) names only what the person did; the fake share module adds
 * the resolved `items` and `simulated: true`, so neither is accepted here.
 */
const shareOpenResultSchema = z.strictObject({
  outcome: z.enum(["shared", "unknown"]),
  target: z.string().min(1).max(256).optional(),
});

function shareResultIssue(call: string, result: unknown): string | undefined {
  if (call !== "share.open" || shareOpenResultSchema.safeParse(result).success) {
    return undefined;
  }
  return 'A share.open result is {outcome: "shared" | "unknown", target?} with a target of 1 to 256 characters; the runtime adds items and simulated: true. To simulate a cancel, use {error: {code: "cancelled"}}.';
}

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
    const resultIssue =
      mediaFilesResultIssue(call, result.data) ?? shareResultIssue(call, result.data);
    if (resultIssue !== undefined) {
      return { issue: ["outcome", resultIssue] };
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

/** Refuse before dispatch, including when an older connection has no capability list. */
export function requirePrototypePlatformOutcomesSupport(
  requestType: string,
  supports: (capability: string) => boolean | undefined,
): void {
  if (
    requestType === "queue_prototype_call_outcome" &&
    supports(PROTOTYPE_PLATFORM_OUTCOMES_CAPABILITY) !== true
  ) {
    throw new ActionableError(prototypePlatformOutcomesUnsupportedMessage());
  }
}

/** Typed wire builder shared by direct client requests and the host tool path. */
export function queuePrototypeCallOutcomeMessage(
  args: PrototypePlatformOutcomeRequest & { requestId?: string },
): QueuePrototypeCallOutcomeMessage {
  const { issue } = validatePrototypePlatformOutcome(args.call, args.outcome);
  if (!args.id || issue) {
    throw new ActionableError(issue?.[1] ?? "simulate requires id");
  }
  return ctrlProxyRequests.queuePrototypeCallOutcome({ ...args, requestId: args.requestId ?? "" });
}
