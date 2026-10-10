import type {
  ManagedSlotDeletionResult,
  ManagedSlotDeletionTarget,
  ManagedSlotDeviceDeleter,
} from "../daemon/managedSlots/reconciler";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import {
  getDaemonDeviceDeletion,
  isTeardownFailure,
  type DaemonDeviceDeletion,
  type TeardownToolResponse,
} from "./deviceTools";

/**
 * {@link ManagedSlotDeviceDeleter} over the verified `deleteDevice` workflow (stop, destroy, verify
 * absence), run as the daemon. `absent` only when the workflow confirmed the device gone
 * (`destroyed` or `already_absent`); anything else, including an unavailable workflow, is `failed`
 * and never treated as absence.
 */
export class WorkflowManagedSlotDeviceDeleter implements ManagedSlotDeviceDeleter {
  constructor(
    private readonly timer: Pick<Timer, "now">,
    private readonly deletion: () => DaemonDeviceDeletion | undefined = getDaemonDeviceDeletion,
  ) {}

  async deleteAndVerifyAbsence(
    target: ManagedSlotDeletionTarget,
  ): Promise<ManagedSlotDeletionResult> {
    const run = this.deletion();
    if (!run) {
      return { kind: "failed", message: "The device delete workflow is not available yet" };
    }
    const response = await run(
      {
        target: {
          platform: target.platform,
          isVirtual: true,
          stableId: target.stableId,
          ...(target.name ? { stableName: target.name } : {}),
        },
        mode: "destroy",
        verifyAbsence: true,
        timeoutMs: Math.max(1, target.deadlineMs - this.timer.now()),
      },
      target.signal,
    );
    if (isTeardownFailure(response)) {
      return { kind: "failed", message: teardownFailureMessage(response), evidence: response };
    }
    return { kind: "absent", evidence: response };
  }
}

function teardownFailureMessage(response: TeardownToolResponse): string {
  const text = response.content[0]?.text;
  if (text === undefined) {
    return "deleteDevice failed";
  }
  try {
    const payload: unknown = JSON.parse(text);
    if (payload && typeof payload === "object" && "error" in payload) {
      const error = (payload as { error?: unknown }).error;
      if (typeof error === "string") {
        return error;
      }
    }
  } catch (error) {
    // The workflow always emits JSON; the raw text is still a usable message if it ever does not.
    logger.debug(`[ManagedSlots] Unparsed deleteDevice failure text: ${errorMessage(error)}`);
  }
  return text;
}
