import {
  commitAcquisition,
  runWithAcquisitionReceipt,
  type AcquisitionReceipt,
} from "./acquisitionReceipt";
import { defaultDaemonContext } from "./daemonContext";
import { ActionableError } from "../models/ActionableError";
import { isClientCancelled, runOutsideRequestContext } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { ambientExecutionIdReader } from "./deviceExecutionBinding";
import { executionTracker } from "./executionTracker";

/**
 * Why the session an undelivered acquisition holds must be left alone, if it must. An autolock
 * session is published to its connection before the acquiring call returns, so by the time that
 * call turns out undelivered the client may hold the session after all: a sibling acquisition
 * reused and returned it, a call resolved it, or its keeper heartbeated it (each advances the
 * session's activity generation), or a control call is driving the device right now. A session is
 * never released under any of those.
 */
function sessionHeldElsewhere(receipt: AcquisitionReceipt): string | undefined {
  const { minted } = receipt;
  if (minted && minted.session.activityGeneration !== minted.activityGeneration) {
    return `session ${minted.session.sessionId} was used since this call minted it`;
  }
  const sessionId = (minted ?? receipt.rebound)?.session.sessionId;
  if (
    sessionId &&
    executionTracker.hasActiveDeviceSessionExecutions(sessionId, {
      excludeExecutionId: ambientExecutionIdReader.getExecutionId(),
      excludeReads: true,
    })
  ) {
    return `another call is running on session ${sessionId}`;
  }
  return undefined;
}

/**
 * Take back everything `receipt` records, for a request whose result never reached its client:
 * the session it minted is released for good (its claim goes with the device), a session it moved
 * is moved back, and the device it booted or created is stopped or deleted. Nothing else is
 * touched, and nothing at all once the client holds the session through another call. Never
 * rejects: the request already ended in a cancellation, and a failed step is logged.
 */
export async function undoUndeliveredAcquisition(
  receipt: AcquisitionReceipt,
  reason: unknown,
): Promise<void> {
  const pool = defaultDaemonContext.devicePoolWrites();
  if (!pool) {
    return;
  }
  const heldElsewhere = sessionHeldElsewhere(receipt);
  if (heldElsewhere) {
    commitAcquisition(receipt);
    logger.info(`[DeviceTools] Not undoing a cancelled acquisition: ${heldElsewhere}`);
    return;
  }
  // Each part is taken back at most once, however many layers observe the same cancellation.
  const { started } = receipt;
  receipt.started = undefined;
  try {
    // The request that started this work is over; its cancellation must not stop the undo.
    await runOutsideRequestContext(async () => {
      await pool.releaseUndeliveredAcquisition(receipt);
      receipt.minted = undefined;
      receipt.rebound = undefined;
      await started?.rollBack(reason);
    });
  } catch (error) {
    logger.warn(
      `[DeviceTools] Undoing an undelivered acquisition failed: ${errorMessage(error)}`,
      error,
    );
  }
}

/** What a cancelled acquiring call fails with: the cancellation itself when it is an error. */
function cancellationFailure(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new ActionableError("MCP request was cancelled during acquisition.");
}

/**
 * Run one acquiring tool call. Everything it creates is recorded on a receipt of its own, and a
 * call whose client cancelled the request by the time its handler finishes is undone instead of
 * answered: the transport drops that answer, so no client knows the session it names (#11593).
 * An abort the daemon raised itself (device loss, session release) still delivers the result and
 * undoes nothing. `undelivered` builds what the cancelled call reports in place of `result`; by
 * default the call fails with the cancellation.
 */
export async function acquireUndoneIfUndelivered<T>(
  signal: AbortSignal | undefined,
  acquire: (receipt: AcquisitionReceipt) => Promise<T>,
  undelivered: (reason: unknown, result: T) => T | Promise<T> = (reason) => {
    throw cancellationFailure(reason);
  },
): Promise<T> {
  const receipt: AcquisitionReceipt = {};
  let result: T;
  try {
    result = await runWithAcquisitionReceipt(receipt, () => acquire(receipt));
  } catch (error) {
    if (isClientCancelled(signal)) {
      await undoUndeliveredAcquisition(receipt, signal?.reason);
    } else {
      commitAcquisition(receipt);
    }
    throw error;
  }
  if (!isClientCancelled(signal)) {
    commitAcquisition(receipt);
    return result;
  }
  await undoUndeliveredAcquisition(receipt, signal?.reason);
  return await undelivered(signal?.reason, result);
}
