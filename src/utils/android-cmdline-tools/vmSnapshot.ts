import { ExecResult } from "../../models";

export type VmSnapshotAction = "save" | "load" | "delete";

const OK_TOKEN = /\bOK\b/;
const KO_TOKEN = /\bKO\b/;

// The emulator console spells deletion `del`, not `delete` — `save`/`load` are
// spelled the same either way. Keep the wire verb here and the human-readable
// action word in the messages below, so error text stays readable (#6490).
const VM_SNAPSHOT_CONSOLE_VERBS: Record<VmSnapshotAction, string> = {
  save: "save",
  load: "load",
  delete: "del",
};

export function buildVmSnapshotCommand(action: VmSnapshotAction, snapshotName: string): string {
  return `emu avd snapshot ${VM_SNAPSHOT_CONSOLE_VERBS[action]} ${snapshotName}`;
}

/** Marker appended by {@link buildVmSnapshotErrorMessage} for an absent snapshot. */
const MISSING_SNAPSHOT_MARKER = "snapshot not found";

/**
 * True when a failed `delete` means the in-AVD snapshot was already gone.
 * Reclaim treats that as success: the bytes the caller wanted freed are freed
 * (#6490).
 */
export function isMissingVmSnapshotError(errorMessage: string | undefined): boolean {
  return (errorMessage ?? "").includes(MISSING_SNAPSHOT_MARKER);
}

export function evaluateVmSnapshotResult(
  action: VmSnapshotAction,
  snapshotName: string,
  result: ExecResult,
): { ok: boolean; errorMessage?: string } {
  const output = combineVmSnapshotOutput(result.stdout, result.stderr);
  const upper = output.toUpperCase();
  const hasKo = KO_TOKEN.test(upper);
  if (hasKo) {
    return { ok: false, errorMessage: buildVmSnapshotErrorMessage(action, snapshotName, output) };
  }
  const hasOk = OK_TOKEN.test(upper);
  if (hasOk) {
    return { ok: true };
  }
  const detail = output ? `unexpected response: ${output}` : "no response from emulator";
  return { ok: false, errorMessage: buildVmSnapshotErrorMessage(action, snapshotName, detail) };
}

export function formatVmSnapshotExecutionError(
  action: VmSnapshotAction,
  snapshotName: string,
  error: unknown,
): string {
  const detail = describeVmSnapshotError(error);
  return buildVmSnapshotErrorMessage(action, snapshotName, detail);
}

function buildVmSnapshotErrorMessage(
  action: VmSnapshotAction,
  snapshotName: string,
  detail: string,
): string {
  const trimmed = detail.trim();
  const cleaned = trimmed.replace(/^KO[:\s]*/i, "").trim();
  const lower = cleaned.toLowerCase();
  const base = `VM snapshot ${action} failed for '${snapshotName}'`;

  if (!cleaned) {
    return `${base}: no response from emulator`;
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return `${base}: command timed out (${cleaned})`;
  }
  if (lower.includes("device offline") || lower.includes("offline")) {
    return `${base}: emulator is offline or not responding (${cleaned})`;
  }
  if (
    lower.includes("device not found") ||
    lower.includes("no devices") ||
    lower.includes("no emulators")
  ) {
    return `${base}: emulator not found (${cleaned})`;
  }
  if (
    lower.includes("unknown command") ||
    lower.includes("not supported") ||
    lower.includes("unknown avd")
  ) {
    return `${base}: emulator does not support snapshot commands (${cleaned})`;
  }
  if (
    lower.includes("snapshot") &&
    (lower.includes("not found") || lower.includes("does not exist"))
  ) {
    return `${base}: ${MISSING_SNAPSHOT_MARKER} (${cleaned})`;
  }

  return `${base}: ${cleaned}`;
}

function combineVmSnapshotOutput(stdout: string, stderr: string): string {
  return [stdout, stderr]
    .filter((part) => part && part.trim().length > 0)
    .join("\n")
    .trim();
}

function describeVmSnapshotError(error: unknown): string {
  if (error instanceof Error) {
    const errorWithOutput = error as Error & { stdout?: string; stderr?: string };
    return [error.message, errorWithOutput.stdout, errorWithOutput.stderr]
      .filter(Boolean)
      .join("\n");
  }
  return String(error);
}
