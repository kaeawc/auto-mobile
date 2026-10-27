import type {
  BindingDeletionResult,
  BindingDeletionTarget,
  BindingDeviceDeleter,
} from "./reconciler";
import { EMULATOR_TEARDOWN_FAILED_CODE } from "../../../features/deviceLifecycle/teardown/stuckEmulatorEscalation";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import { getDaemonDeviceDeletion, type DaemonDeviceDeletion } from "../../daemonDeviceDeletion";
import {
  isTeardownFailure,
  type TeardownToolResponse,
} from "../../../features/deviceLifecycle/deviceLifecycleCore";

// Only read-only resolution and ownership admission failures prove no native mutation.
const PRE_NATIVE_REFUSALS = [
  "device_assigned_to_binding",
  "device_owned_by_other_session",
  "device_owned_by_other_daemon",
  "inventory_incomplete",
  "booted_inventory_incomplete",
  "target_identity_conflict",
  "target_identity_unresolved",
  "target_not_destroyable",
] as const;

/**
 * {@link BindingDeviceDeleter} over the verified `deleteDevice` workflow (stop, destroy, verify
 * absence), run as the daemon. `absent` only when the workflow confirmed the device gone
 * (`destroyed` or `already_absent`); anything else, including an unavailable workflow, is `failed`
 * and never treated as absence.
 */
export class WorkflowBindingDeviceDeleter implements BindingDeviceDeleter {
  constructor(
    private readonly timer: Pick<Timer, "now">,
    private readonly deletion: () => DaemonDeviceDeletion | undefined = getDaemonDeviceDeletion,
  ) {}

  async deleteAndVerifyAbsence(target: BindingDeletionTarget): Promise<BindingDeletionResult> {
    const run = this.deletion();
    if (!run) {
      return {
        kind: "failed",
        message: "The device delete workflow is not available yet",
        notAttempted: { reason: "workflow_unavailable" },
      };
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
      return { kind: "failed", ...teardownFailureDetails(response), evidence: response };
    }
    return { kind: "absent", evidence: response };
  }
}

function teardownFailureDetails(
  response: TeardownToolResponse,
): Pick<
  Extract<BindingDeletionResult, { kind: "failed" }>,
  "message" | "notAttempted" | "escalationExhausted"
> {
  const text = response.content[0]?.text;
  if (text === undefined) {
    return { message: "deleteDevice failed" };
  }
  try {
    const payload: unknown = JSON.parse(text);
    if (payload && typeof payload === "object") {
      const message =
        "error" in payload && typeof payload.error === "string" ? payload.error : text;
      const reason = "failure" in payload ? preNativeRefusalReason(payload.failure) : undefined;
      if (reason) {
        return { message, notAttempted: { reason } };
      }
      if (isEscalationExhausted("failure" in payload ? payload.failure : undefined)) {
        return { message, escalationExhausted: true };
      }
      return { message };
    }
  } catch (error) {
    // The workflow always emits JSON; the raw text is still a usable message if it ever does not.
    logger.debug(`[Bindings] Unparsed deleteDevice failure text: ${errorMessage(error)}`);
  }
  return { message: text };
}

function preNativeRefusalReason(
  failure: unknown,
): (typeof PRE_NATIVE_REFUSALS)[number] | undefined {
  if (
    !failure ||
    typeof failure !== "object" ||
    !("phase" in failure) ||
    failure.phase !== "precondition" ||
    !("code" in failure)
  ) {
    return undefined;
  }
  return PRE_NATIVE_REFUSALS.find((code) => code === failure.code);
}

function isEscalationExhausted(failure: unknown): boolean {
  return (
    !!failure &&
    typeof failure === "object" &&
    "code" in failure &&
    failure.code === EMULATOR_TEARDOWN_FAILED_CODE
  );
}
