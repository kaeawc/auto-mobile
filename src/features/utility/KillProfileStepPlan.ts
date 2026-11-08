import type { BootedDevice } from "../../models";
import { throwIfAborted } from "../../utils/toolUtils";
import type { KillProfileDependencies } from "./ApplyKillProfile";
import type { KillProfileRestoreAction } from "./KillProfileRestore";

export interface KillProfileBootObservation {
  bootReceivers: string[];
  bootPermissionGranted: boolean;
  stopped: boolean;
  /** Predicted default delivery from the dump, not a broadcast sent by this check. */
  bootBroadcastDelivered: boolean;
  pendingAlarms: number;
}

/** One step resolved against a package: its command and how to capture what it changes. */
export interface StepPlan {
  label: string;
  command: string;
  minApi?: number;
  /** Multi-command writes can partially succeed even when the shell reports failure. */
  retainOnWriteFailure?: boolean;
  /** Wait only after a successful read-back. */
  afterVerify?: () => Promise<void>;
  /** Read-only diagnostic; never sends a boot broadcast. */
  observe?: () => Promise<KillProfileBootObservation>;
  /** Reads the facet before the write and returns how to restore it. */
  capture?: () => Promise<KillProfileRestoreAction>;
  /** Optional read-back for steps whose successful shell write does not prove application. */
  verify?: () => Promise<string | undefined>;
  /** A mismatched read-back may reflect a partial write; retain the original state for cleanup. */
  retainOnVerificationFailure?: boolean;
  /** Output that means the device cannot do this, not that the command broke. */
  unsupportedOutput?: RegExp;
}

export interface Context {
  device: BootedDevice;
  appId: string;
  quoted: string;
  deps: KillProfileDependencies;
}

export async function run(
  context: Context,
  command: string,
  maxBuffer?: number,
): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(context.deps.signal);
  const result = await context.deps.shell.executeCommand(command, {
    noRetry: true,
    signal: context.deps.signal,
    maxBuffer,
  });
  return { stdout: result.stdout, stderr: result.stderr ?? "" };
}
