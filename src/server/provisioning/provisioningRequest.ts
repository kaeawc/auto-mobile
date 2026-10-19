import { provisionCancellationOutcomes } from "../../daemon/provisionCancellationOutcomes";
import { errorMessage } from "../../utils/describeUnknownError";
import { ProgressCallback } from "../toolRegistry";
import { logger } from "../../utils/logger";
import { formatToolParamError } from "../toolParamError";
import { type AcquisitionReceipt } from "../../daemon/acquisitionReceipt";
import {
  acquireUndoneIfUndelivered,
  undoUndeliveredAcquisition,
} from "../../daemon/acquisitionUndo";
import { DaemonHandoffInterruptionError } from "../../daemon/daemonHandoffInterruption";
import {
  ActiveProvisionDeviceRequest,
  PROVISION_DEVICE_SETTLEMENT_WAIT_MS,
  ProvisionDeviceArgs,
  activeProvisionDeviceRequests,
  cancelProvisionDeviceRequest,
  createProvisionDeviceResponse,
  createToolErrorResponse,
  getDeviceToolsDependencies,
  isProvisionDeviceCallerAbort,
  parseProvisionDeviceArgs,
  provisionDeviceSchema,
  waitForProvisionDeviceRequest,
  waitForProvisionDeviceSettlement,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import {
  type ProvisionCancellation,
  type ProvisionDeviceToolResponse,
  type ProvisioningContext,
} from "./provisioningTypes";
import { executeProvisionDevice } from "./provisioningRun";
import {
  describeProvisionRequest,
  failureBoundaryRecovery,
  provisionDeviceErrorResponse,
  provisionDeviceRecovery,
} from "./provisioningErrors";

export async function provisionDeviceHandler(
  ctx: ProvisioningContext,
  input: Partial<ProvisionDeviceArgs>,
  _progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  let args: ProvisionDeviceArgs;
  try {
    args = parseProvisionDeviceArgs(input);
  } catch (error) {
    // The MCP boundary already validated the caller's arguments; a failure
    // here means the re-parse rejected something the boundary let through
    // (an internal param, or a genuinely malformed public argument on a
    // non-MCP call path). Either way the caller gets a structured, coded
    // error instead of a raw ZodError escaping the tool.
    const message = `Invalid parameters for tool provisionDevice: ${formatToolParamError(
      "provisionDevice",
      error,
      input,
      provisionDeviceSchema,
    )}`;
    logger.warn(`[DeviceTools] ${message}`, error);
    return createToolErrorResponse("invalid_arguments", message);
  }
  // Every call runs its own lifecycle (#11065). A concurrent request for the
  // same exact device waits on the device lifecycle lease and then adopts the
  // device or is refused by session ownership; nothing is replayed.
  const controller = new AbortController();
  const lifecycleEvidence: ActiveProvisionDeviceRequest["lifecycleEvidence"] = {};
  const cancellation: ProvisionCancellation = {};
  let request: ActiveProvisionDeviceRequest | undefined;
  // The lifecycle starts inside the request's receipt scope, so its bind and boot record there.
  return await acquireUndoneIfUndelivered<ProvisionDeviceToolResponse>(
    signal,
    async (receipt) => {
      const promise = executeProvisionDevice(ctx, args, controller.signal, lifecycleEvidence);
      const started: ActiveProvisionDeviceRequest = { promise, controller, lifecycleEvidence };
      request = started;
      activeProvisionDeviceRequests.add(started);
      const retire = (): void => {
        activeProvisionDeviceRequests.delete(started);
      };
      void promise.then(retire, retire);
      return await awaitProvisionDeviceRequest(args, started, signal, { receipt, cancellation });
    },
    // A cancel that lands after the lifecycle bound its session is answered like one that
    // lands before; a lifecycle that already failed keeps its own answer.
    async (reason, response) =>
      cancellation.response ??
      (response.isError === true
        ? response
        : await cancelledProvisionDeviceResponse(args, request!, reason, {
            receipt: {},
            cancellation,
          })),
  );
}

/**
 * Answer a request its caller cancelled. The lifecycle is cancelled with it; one that had
 * already bound its session is undone through the request's receipt before the evidence is
 * read, so the response reports what the cancelled call left behind (#11593).
 */
async function cancelledProvisionDeviceResponse(
  args: ProvisionDeviceArgs,
  request: ActiveProvisionDeviceRequest,
  error: unknown,
  { receipt, cancellation }: { receipt: AcquisitionReceipt; cancellation: ProvisionCancellation },
): Promise<ProvisionDeviceToolResponse> {
  cancelProvisionDeviceRequest(request, error);
  const settled = await waitForProvisionDeviceSettlement(
    request.promise,
    getDeviceToolsDependencies().timer,
    PROVISION_DEVICE_SETTLEMENT_WAIT_MS,
  );
  if (!settled) {
    logger.warn(
      `[DeviceTools] provisionDevice ${describeProvisionRequest(args)} caller cancellation stopped waiting for its lifecycle to settle.`,
    );
  }
  await undoUndeliveredAcquisition(receipt, error);
  // The caller went away, which is not a provisioning failure: report it
  // with a code of its own. The lifecycle is cancelled with its caller.
  logger.warn(
    `[DeviceTools] provisionDevice ${describeProvisionRequest(args)} caller cancelled the request: ` +
      `${errorMessage(error)}`,
    error,
  );
  const cancelledResponse = createToolErrorResponse(
    "request_cancelled",
    "provisionDevice request was cancelled by the caller; its provisioning work was cancelled too.",
    {
      recovery: provisionDeviceRecovery("caller_cancellation", request, {
        settled,
        retryAfterMs: PROVISION_DEVICE_SETTLEMENT_WAIT_MS,
      }),
    },
  );
  // The daemon answered the abandoned request already; hand it this result so that reply
  // can carry the typed envelope and recovery evidence.
  if (args.__mcpLiveDeadlineKey) {
    provisionCancellationOutcomes.publish(args.__mcpLiveDeadlineKey, cancelledResponse);
  }
  cancellation.response = cancelledResponse;
  return cancelledResponse;
}

async function awaitProvisionDeviceRequest(
  args: ProvisionDeviceArgs,
  request: ActiveProvisionDeviceRequest,
  signal: AbortSignal | undefined,
  undo: { receipt: AcquisitionReceipt; cancellation: ProvisionCancellation },
): Promise<ProvisionDeviceToolResponse> {
  try {
    const result = await waitForProvisionDeviceRequest(request.promise, signal);
    return createProvisionDeviceResponse(result);
  } catch (error) {
    if (error instanceof DaemonHandoffInterruptionError) {
      if (cancelProvisionDeviceRequest(request, error)) {
        // Let the cancelled lifecycle unwind (rollback, lease release) so the
        // recovery evidence reports what it left behind.
        await request.promise.catch((error) => {
          // Handoff already reports interruption; this wait only lets rollback settle.
          logger.debug(`Provision handoff settlement rejected: ${errorMessage(error)}`);
        });
      }
      logger.warn(
        `[DeviceTools] provisionDevice ${describeProvisionRequest(args)} interrupted by daemon handoff: ${errorMessage(error)}`,
        error,
      );
      return provisionDeviceErrorResponse(
        error,
        provisionDeviceRecovery("daemon_handoff", request, {
          originalError: { code: error.code, message: error.message },
        }),
      );
    }
    if (isProvisionDeviceCallerAbort(error, signal)) {
      return await cancelledProvisionDeviceResponse(args, request, error, undo);
    }
    logger.warn(
      `[DeviceTools] provisionDevice ${describeProvisionRequest(args)} failed: ${errorMessage(error)}`,
      error,
    );
    return provisionDeviceErrorResponse(error, failureBoundaryRecovery(error, request));
  }
}
