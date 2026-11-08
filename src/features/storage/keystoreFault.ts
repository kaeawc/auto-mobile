import { z } from "zod/v4";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { shellQuote } from "../../utils/shellQuote";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

/** Fault kinds the debug SDK's `KeystoreFaultPlan` accepts, by exact name. */
export const KEYSTORE_FAULT_KINDS = [
  "KEY_STORE_EXCEPTION",
  "PROVIDER_EXCEPTION",
  "USER_NOT_AUTHENTICATED",
  "DELAY",
  "STRONGBOX_UNAVAILABLE",
] as const;
export type KeystoreFaultKind = (typeof KEYSTORE_FAULT_KINDS)[number];

/** The SDK's `DELAY` bound, inclusive (`MAX_INJECTED_DELAY_PER_CALL_MS`). */
export const KEYSTORE_FAULT_MIN_DELAY_MS = 1;
export const KEYSTORE_FAULT_MAX_DELAY_MS = 10_000;

export type KeystoreFaultMethod = "injectFault" | "clearFaults";

/**
 * The provider's `injectFault`/`clearFaults` envelope (`KeystoreStateHandler.updateFaults`).
 * Identifiers and outcomes only; unknown fields are stripped.
 */
export const keystoreFaultSchema = z.object({
  schemaVersion: z.literal(1),
  capability: z.literal("storage.keystore"),
  outcome: z.enum([
    "ok",
    "disabled",
    "unavailable",
    "unsupported",
    "scope_not_declared",
    "authorization_denied",
    "invalid_selector",
  ]),
  reason: z
    .enum([
      "DISABLED",
      "BRIDGE_NOT_INSTALLED",
      "BRIDGE_UNAVAILABLE",
      "DECLARED_UNSUPPORTED",
      "SCOPE_NOT_DECLARED",
      "MUTATION_NOT_ALLOWED",
      "EMPTY_SELECTOR",
      "INVALID_FAULT",
    ])
    .nullable()
    .optional(),
  bridgeAvailable: z.boolean(),
  requestedScope: z.string().nullable().optional(),
  requestedAlias: z.string().nullable().optional(),
  requestedKind: z.string().nullable().optional(),
});
export type KeystoreFault = z.infer<typeof keystoreFaultSchema>;

export interface KeystoreFaultRequest {
  scope?: string;
  alias?: string;
  /** injectFault only. */
  kind?: string;
  /** injectFault with kind DELAY only. */
  delayMs?: number;
}

/** Narrow transport seam for the debug SDK's fault calls; tests inject a fake. */
export interface KeystoreFaultBackend {
  updateKeystoreFaults(
    packageName: string,
    method: KeystoreFaultMethod,
    request: KeystoreFaultRequest,
  ): Promise<KeystoreFault>;
}

/**
 * Checks a request the way the SDK provider does, so an invalid one gets the provider's own
 * refusal without a device round trip: a blank selector is EMPTY_SELECTOR; for injectFault an
 * unknown kind, or DELAY without a delay in range, is INVALID_FAULT. Returns null when valid.
 */
export function validateKeystoreFaultRequest(
  method: KeystoreFaultMethod,
  request: KeystoreFaultRequest,
): KeystoreFault | null {
  const refuse = (reason: "EMPTY_SELECTOR" | "INVALID_FAULT"): KeystoreFault => ({
    ...faultEnvelope(request, true),
    outcome: "invalid_selector",
    reason,
  });
  if (!request.scope?.trim() && !request.alias?.trim()) {
    return refuse("EMPTY_SELECTOR");
  }
  if (method === "clearFaults") {
    return null;
  }
  if (!KEYSTORE_FAULT_KINDS.some((kind) => kind === request.kind)) {
    return refuse("INVALID_FAULT");
  }
  const delay = request.delayMs;
  const delayValid =
    delay !== undefined &&
    Number.isInteger(delay) &&
    delay >= KEYSTORE_FAULT_MIN_DELAY_MS &&
    delay <= KEYSTORE_FAULT_MAX_DELAY_MS;
  return request.kind === "DELAY" && !delayValid ? refuse("INVALID_FAULT") : null;
}

function faultEnvelope(
  request: KeystoreFaultRequest,
  bridgeAvailable: boolean,
): Omit<KeystoreFault, "outcome"> {
  return {
    schemaVersion: 1,
    capability: "storage.keystore",
    bridgeAvailable,
    requestedScope: request.scope,
    requestedAlias: request.alias,
    requestedKind: request.kind,
  };
}

/** Deadline for one provider call; fault updates do no Keystore work, so injected delay never applies. */
export const KEYSTORE_FAULT_CALL_TIMEOUT_MS = 10_000;

/**
 * Calls the debug SDK's `content://<package>.automobile.keystore` provider with
 * `adb shell content call`. The provider replies `Bundle[{result=<json>}]`; the JSON is parsed
 * and schema-checked, never pattern-matched field by field.
 */
export class AdbKeystoreFaultClient implements KeystoreFaultBackend {
  constructor(private readonly adb: AdbCommandRunner) {}

  async updateKeystoreFaults(
    packageName: string,
    method: KeystoreFaultMethod,
    request: KeystoreFaultRequest,
  ): Promise<KeystoreFault> {
    const refusal = (reason: "BRIDGE_NOT_INSTALLED" | "BRIDGE_UNAVAILABLE"): KeystoreFault => ({
      ...faultEnvelope(request, false),
      outcome: "unavailable",
      reason,
    });
    let output: string;
    try {
      const result = await this.adb.executeCommand(
        buildFaultCommand(packageName, method, request),
        {
          timeoutMs: KEYSTORE_FAULT_CALL_TIMEOUT_MS,
          noRetry: true,
        },
      );
      output = [result.stdout, result.stderr].filter((part) => part.trim()).join("\n");
    } catch (error) {
      logger.warn(`[KEYSTORE] ${method} content call failed: ${errorMessage(error)}`, error);
      return refusal("BRIDGE_UNAVAILABLE");
    }
    if (/Unknown authority|Could not find provider/i.test(output)) {
      return refusal("BRIDGE_NOT_INSTALLED");
    }
    const parsed = keystoreFaultSchema.safeParse(parseBundleResult(output));
    if (!parsed.success) {
      logger.warn(`[KEYSTORE] ${method} reply was not a Keystore fault envelope: ${output}`);
      return refusal("BRIDGE_UNAVAILABLE");
    }
    return parsed.data;
  }
}

/** Shell command for one provider call; every value is shell-quoted. */
export function buildFaultCommand(
  packageName: string,
  method: KeystoreFaultMethod,
  request: KeystoreFaultRequest,
): string {
  const uri = `content://${packageName}.automobile.keystore`;
  const extras: string[] = [];
  const add = (key: string, type: "s" | "l", value: string | number | undefined) => {
    if (value !== undefined) {
      extras.push(` --extra ${key}:${type}:${shellQuote(String(value))}`);
    }
  };
  add("scope", "s", request.scope);
  add("alias", "s", request.alias);
  if (method === "injectFault") {
    add("kind", "s", request.kind);
    add("delayMs", "l", request.delayMs);
  }
  return `shell content call --uri ${shellQuote(uri)} --method ${method}${extras.join("")}`;
}

/**
 * The provider returns one Bundle entry, `result`, so `content call` prints
 * `Result: Bundle[{result=<json>}]`: the JSON runs from after `result=` to the closing `}]`.
 */
function parseBundleResult(output: string): unknown {
  const marker = "result=";
  const start = output.indexOf(marker);
  const end = output.lastIndexOf("}]");
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(output.slice(start + marker.length, end));
  } catch (error) {
    // An unparseable reply is reported as BRIDGE_UNAVAILABLE by the caller, which logs it.
    logger.debug(`[KEYSTORE] fault reply JSON did not parse: ${errorMessage(error)}`);
    return undefined;
  }
}
