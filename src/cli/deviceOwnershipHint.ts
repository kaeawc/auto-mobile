import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../daemon/inputDeviceOwnership";

/** Tools that stop a device and therefore accept `force` to override a held-device refusal. */
const FORCE_OVERRIDE_TOOLS: ReadonlySet<string> = new Set(["killDevice", "deleteDevice"]);

function refusalCode(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  // Tool-call refusals carry `code`; a deleteDevice precondition failure nests it in `failure`.
  const failure = record.failure;
  return failure && typeof failure === "object"
    ? (failure as Record<string, unknown>).code
    : record.code;
}

/**
 * A `--cli` invocation is a separate process, so a call without `--session-uuid` is sessionless
 * and the daemon refuses it on a device another session holds (#10743, #10783, #10785). The
 * refusal message names the rule; this adds the CLI-shaped remedy. Returns undefined for any
 * other failure.
 */
export function cliDeviceOwnershipHint(payload: unknown, toolName: string): string | undefined {
  if (refusalCode(payload) !== DEVICE_OWNED_BY_OTHER_SESSION_CODE) {
    return undefined;
  }
  const forceHint = FORCE_OVERRIDE_TOOLS.has(toolName)
    ? ` To stop it anyway, pass --force true.`
    : "";
  return (
    "Hint: a device a session holds takes calls only from that session. Re-run with " +
    "--session-uuid <uuid>, the sessionUuid that getAndroid, getApple or startDevice returned " +
    `when the device was acquired, or wait for the holder to release it.${forceHint}`
  );
}
