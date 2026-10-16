import { z } from "zod/v4";
import type { BootedDevice } from "../models";
import {
  createPrototypeReverseAdb,
  type PrototypeAdbReverseManager,
  type PrototypeReverseReport,
  type StagedReverses,
} from "../features/prototype/PrototypeAdbReverseManager";
import type { PrototypeMutation } from "../features/prototype/PrototypeStatusStore";
import type { PrototypeResult } from "../features/observe/android/ctrlProxyProtocol";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";

/** Wires the prototype tool to the per-device adb reverse manager (#12530). */

/** Output fields of show, save and inspect that report the automatic adb reverse. */
export const reverseOutputShape = {
  unreversiblePorts: z
    .array(z.object({ prototypeId: z.string(), url: z.string(), reason: z.string() }))
    .optional()
    .describe(
      'Android show and inspect: loopback URLs of via "device" request actions whose port is not a literal (a binding, or an unparseable URL), so no adb reverse was made for them. Use via "host" for those requests. Absent when none',
    ),
  reverseFailures: z
    .array(z.object({ prototypeId: z.string(), port: z.number().int(), error: z.string() }))
    .optional()
    .describe(
      'Android show and inspect: loopback ports of via "device" request actions whose automatic adb reverse failed (best-effort; the show is not failed). Absent when none',
    ),
};

/** What the reverse steps need of the tool's handler dependencies. */
export interface ReverseDependencies {
  reverses: PrototypeAdbReverseManager;
  adbFactory?: { create(device: BootedDevice): Pick<AdbExecutor, "executeCommand"> };
  target: { android?: unknown };
}

/** The slice of the tool arguments the reverse steps read. */
export interface ReverseArgs {
  action: string;
  spec?: unknown;
  id?: string;
}

/** The reverse steps of one show or dismiss, bound to its device, arguments and target. */
export function reverseLifecycle(
  dependencies: ReverseDependencies,
  device: BootedDevice,
  args: ReverseArgs & { action: PrototypeMutation },
  target: { id?: string; all?: true },
) {
  // The show's new ports are claimed before the send but kept apart from the earlier claims until
  // the send is settled, so a refused replacement can give them back (see StagedReverses).
  let staged: StagedReverses | undefined;
  const takeStaged = () => {
    const taken = staged;
    staged = undefined;
    return taken;
  };
  return {
    prepare: async (refusals: readonly (PrototypeResult | undefined)[]) => {
      const claim = await reverseLoopbackPorts(dependencies, device, args, target, refusals);
      staged = claim;
      return claim?.report;
    },
    settle: async (success: boolean, previouslyShown: boolean) => {
      const claim = takeStaged();
      if (claim) {
        await (success ? claim.commit() : claim.rollback());
      }
      await settleReverses(dependencies.reverses, device.deviceId, target, {
        action: args.action,
        success,
        previouslyShown,
        staged: claim !== undefined,
      });
    },
    /**
     * The call ended without settling (an exception or abort). Before dispatch nothing reached the
     * device, so the staged claims are given back; after dispatch the show may be on screen, so the
     * new claims stand.
     */
    abandon: async (sent: boolean) => {
      const claim = takeStaged();
      if (claim) {
        await (sent ? claim.commit() : claim.rollback());
      }
    },
    output: (report: PrototypeReverseReport | undefined, success: boolean) =>
      reverseOutput(success ? report : undefined),
  };
}

/** The inspect/show fields for the reverse report; each is absent when empty. */
export function reverseOutput(
  report: PrototypeReverseReport | undefined,
): Partial<PrototypeReverseReport> {
  return {
    ...(report?.unreversiblePorts.length ? { unreversiblePorts: report.unreversiblePorts } : {}),
    ...(report?.reverseFailures.length ? { reverseFailures: report.reverseFailures } : {}),
  };
}

export function withReverseReport<T extends { success: boolean }>(
  output: T,
  report: PrototypeReverseReport | undefined,
) {
  return output.success ? { ...output, ...reverseOutput(report) } : output;
}

/**
 * Android show: makes the loopback ports of via "device" requests reachable with adb reverse before
 * the prototype is sent. Best-effort: the manager logs and reports failures and never throws. iOS
 * simulators share the host's network, so only Android gets a reverse.
 */
export async function reverseLoopbackPorts(
  dependencies: ReverseDependencies,
  device: BootedDevice,
  args: ReverseArgs,
  target: { id?: string },
  refusals: readonly (PrototypeResult | undefined)[],
): Promise<StagedReverses | undefined> {
  if (
    refusals.some((refusal) => refusal !== undefined) ||
    args.action !== "show" ||
    !dependencies.target.android ||
    target.id === undefined
  ) {
    return undefined;
  }
  const adb = (dependencies.adbFactory ?? defaultAdbClientFactory).create(device);
  return dependencies.reverses.stage(
    device.deviceId,
    target.id,
    args.spec,
    createPrototypeReverseAdb(adb),
  );
}

/** The saved prototype's reverse claim is keyed apart from a shown prototype of the same id. */
const savedReverseKey = (id: string) => `saved:${id}`;

/** Re-syncs the patched prototype's ports to the complete spec the patch produced. */
export async function reverseForPatch(
  dependencies: ReverseDependencies,
  device: BootedDevice,
  id: string,
  spec: unknown,
): Promise<undefined> {
  if (dependencies.target.android) {
    await reverseSync(dependencies, device, id, spec);
  }
  return undefined;
}

/**
 * Android save puts the spec's ports under a saved claim that lives until deleteSaved or the
 * device goes away; a prototype launched later with no host connected gets no reverse.
 */
export async function reverseForSavedAction(
  dependencies: ReverseDependencies,
  device: BootedDevice,
  args: ReverseArgs,
): Promise<PrototypeReverseReport | undefined> {
  if (!dependencies.target.android) {
    return undefined;
  }
  if (args.action === "save" && args.spec !== undefined) {
    const id = (args.spec as { id?: unknown }).id;
    return typeof id === "string"
      ? reverseSync(dependencies, device, savedReverseKey(id), args.spec)
      : undefined;
  }
  if (args.action === "deleteSaved" && args.id !== undefined) {
    await dependencies.reverses.release(device.deviceId, savedReverseKey(args.id));
  }
  return undefined;
}

function reverseSync(
  dependencies: ReverseDependencies,
  device: BootedDevice,
  key: string,
  spec: unknown,
): Promise<PrototypeReverseReport> {
  const adb = (dependencies.adbFactory ?? defaultAdbClientFactory).create(device);
  return dependencies.reverses.sync(device.deviceId, key, spec, createPrototypeReverseAdb(adb));
}

/**
 * A landed dismiss, or a first show that never landed, leaves nothing to reach the ports: the
 * prototypes' claims end and the reverses nobody else uses are removed.
 */
async function settleReverses(
  reverses: PrototypeAdbReverseManager,
  deviceId: string,
  target: { id?: string; all?: true },
  outcome: {
    action: PrototypeMutation;
    success: boolean;
    previouslyShown: boolean;
    /** The show's claims were staged and already committed or rolled back. */
    staged: boolean;
  },
): Promise<void> {
  const ended =
    outcome.action === "dismiss"
      ? outcome.success
      : !outcome.staged && !outcome.success && !outcome.previouslyShown;
  if (!ended) {
    return;
  }
  if (target.id !== undefined) {
    await reverses.release(deviceId, target.id);
  } else if (target.all) {
    await reverses.releaseAll(deviceId);
  }
}
