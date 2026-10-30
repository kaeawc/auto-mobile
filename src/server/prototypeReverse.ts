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
export interface ReverseInput {
  action: string;
  spec?: unknown;
  id?: string;
  replaceOthers?: boolean;
}

/** The reverse steps of one show or dismiss, bound to its device, arguments and target. */
export function reverseLifecycle(
  dependencies: ReverseDependencies,
  device: BootedDevice,
  args: ReverseInput & { action: PrototypeMutation },
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
      const claim = await reverseLoopbackPorts(dependencies, device, args, { target, refusals });
      staged = claim;
      return claim?.report;
    },
    // `maybeLanded`: the show threw after dispatch (a timeout or dropped socket), so the prototype
    // may be on screen relying on the staged ports; they are kept, and only a definite failure rolls
    // back. Siblings are released only for a confirmed replacing show.
    settle: async (success: boolean, previouslyShown: boolean, maybeLanded = false) => {
      const claim = takeStaged();
      if (claim) {
        await (success || maybeLanded ? claim.commit() : claim.rollback());
      }
      if (claim && success && args.replaceOthers !== false) {
        await releaseReplaced(dependencies.reverses, device.deviceId, target.id);
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
  args: ReverseInput,
  {
    target,
    refusals,
  }: { target: { id?: string }; refusals: readonly (PrototypeResult | undefined)[] },
): Promise<StagedReverses | undefined> {
  if (
    refusals.some((refusal) => refusal !== undefined) ||
    args.action !== "show" ||
    !dependencies.target.android ||
    target.id === undefined
  ) {
    return undefined;
  }
  return stageReverses(dependencies, device, target.id, args.spec);
}

const SAVED_PREFIX = "saved:";

/** A replacing show ended every other prototype on the device; saved claims live apart. */
const releaseReplaced = (reverses: PrototypeAdbReverseManager, deviceId: string, keep?: string) =>
  reverses.releaseExcept(deviceId, (key) => key === keep || key.startsWith(SAVED_PREFIX));
/** The saved prototype's reverse claim is keyed apart from a shown prototype of the same id. */
const savedReverseKey = (id: string) => `${SAVED_PREFIX}${id}`;

/**
 * Android patch: stages the ports of the complete patched spec, to be settled by `settle` once the
 * device has answered. The patch is never refused here.
 */
export function patchReverseStaging(
  dependencies: ReverseDependencies,
  device: BootedDevice,
  id: string,
) {
  let staged: StagedReverses | undefined;
  return {
    stage: async (spec: unknown): Promise<undefined> => {
      if (dependencies.target.android) {
        staged = await stageReverses(dependencies, device, id, spec);
      }
      return undefined;
    },
    /** Commit when the patch landed (or may have), roll back on a refusal or an exception. */
    settle: async (landed: boolean): Promise<void> => {
      const claim = staged;
      staged = undefined;
      await (landed ? claim?.commit() : claim?.rollback());
    },
  };
}

/**
 * Android save puts the spec's ports under a saved claim that lives until deleteSaved or the
 * device goes away; a prototype launched later with no host connected gets no reverse. The claim
 * changes only when the device reports success: a failed or thrown save adds none, a failed delete
 * keeps it.
 */
export async function withSavedReverses<T extends { success: boolean }>(
  dependencies: ReverseDependencies,
  device: BootedDevice,
  args: ReverseInput,
  dispatch: () => Promise<T>,
): Promise<T> {
  const id = savedId(args);
  if (!dependencies.target.android || id === undefined) {
    return dispatch();
  }
  const key = savedReverseKey(id);
  const staged =
    args.action === "save" && args.spec !== undefined
      ? await stageReverses(dependencies, device, key, args.spec)
      : undefined;
  let result: T | undefined;
  try {
    result = await dispatch();
    return withReverseReport(result, staged?.report) as T;
  } finally {
    const landed = result?.success === true;
    await (landed ? staged?.commit() : staged?.rollback());
    if (landed && args.action === "deleteSaved") {
      await dependencies.reverses.release(device.deviceId, key);
    }
  }
}

function savedId(args: ReverseInput): string | undefined {
  const id = args.action === "save" ? (args.spec as { id?: unknown } | undefined)?.id : args.id;
  return typeof id === "string" ? id : undefined;
}

function stageReverses(
  dependencies: ReverseDependencies,
  device: BootedDevice,
  key: string,
  spec: unknown,
): Promise<StagedReverses> {
  const adb = (dependencies.adbFactory ?? defaultAdbClientFactory).create(device);
  return dependencies.reverses.stage(device.deviceId, key, spec, createPrototypeReverseAdb(adb));
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
