import { OrphanRecorderActiveError } from "../daemon/orphanRecorderRefusal";
import { toActionableError } from "../models/ActionableError";
import { ActionableError, type VideoRecordingMetadata } from "../models";
import { ownerVisibleInScope, type VideoRecordingRecord } from "../db/videoRecordingRepository";
import { createStructuredToolResponse } from "../utils/toolUtils";
import {
  adoptOrphanCaptureArtifact,
  getVideoRecordingMetadata,
  initializeRecordingTeardownRedriveState,
  getStartupOrphanCaptures,
  interruptVideoRecording,
  getVideoRecordingOwnerRef,
  heldVideoRecordingOwner,
  listActiveVideoRecordings,
  stopVideoRecording,
} from "../daemon/videoRecordingManager";
import {
  segmentedSessions,
  type StoppedSegmentedSession,
  type SessionHighlight,
} from "./videoRecordingSegments";
import { assertActiveRecordingOwner, type RecordingToolContext } from "./videoRecordingToolContext";

/**
 * If `recordingId` is the handle for a timer-driven segmented session, stop it
 * (clear the rotation timer + finalize) and return a response listing every
 * segment file path/recordingId in order. Returns null otherwise so callers
 * fall through to the single-recording stop path.
 */
function segmentedStopResponse(stopped: StoppedSegmentedSession) {
  const { sessionId, segments, manifestPath, highlights } = stopped;
  return createStructuredToolResponse({
    action: "stop",
    count: segments.length,
    manifestPath,
    // Each segment carries sessionId + segmentIndex, so `recordings[]` has the same shape
    // whether it came from a by-handle or a bare (multi-session) stop.
    recordings: segments.map((segment) => ({ ...segment, sessionId })),
    segmented: true,
    highlights: highlights?.map((highlight): SessionHighlight => ({ ...highlight, sessionId })),
  });
}

async function tryStopSegmentedSession(
  ctx: RecordingToolContext,
  recordingId: string,
  ownerSessionUuid?: string,
  requesterMcpSessionId?: string,
) {
  const session = segmentedSessions.get(recordingId);
  if (!session) {
    return null;
  }
  assertActiveRecordingOwner(ctx, {
    recordingId,
    deviceId: session.deviceId,
    recordingOwner: session.ownerSession,
    requesterSessionUuid: ownerSessionUuid,
    requesterMcpSessionId,
  });

  try {
    return segmentedStopResponse(await segmentedSessions.stopAndRemove(recordingId, session));
  } catch (error) {
    throw toActionableError(error, `Failed to stop segmented video recording`);
  }
}

export function stopResultEntry(
  metadata: VideoRecordingMetadata,
  device?: { deviceId?: string; platform?: string },
): Record<string, unknown> {
  const codec = metadata.codec ?? "unknown";
  const durationMs = metadata.durationMs ?? 0;
  const sizeBytes = metadata.sizeBytes ?? 0;
  return {
    recordingId: metadata.recordingId,
    filePath: metadata.filePath,
    durationMs,
    videoDurationMs: metadata.videoDurationMs,
    sizeBytes,
    codec,
    recordedPanel: metadata.recordedPanel,
    transitions: metadata.transitions,
    metadata: { ...metadata, durationMs, sizeBytes, codec },
    deviceId: device?.deviceId,
    platform: device?.platform,
  };
}

/**
 * A recording that is not active any more but was finalized (a release-time stop, #10826)
 * is returned to its owner instead of failing: the owner-scoped lookup needs no device, so a
 * stop by id never allocates one (#10958).
 */
/**
 * Whether a requester may reach a finalized recording of `owner` on `deviceId`: the same owners
 * `assertActiveRecordingOwner` accepts (#11533), so a recording stays reachable after the stop that
 * finalized it. A sessionless requester or an ownerless recording is unscoped, as before: fetching
 * a finalized artifact stops nothing, so it keeps that rule where the active stop no longer does
 * (#11647).
 */
function finalizedOwnerVisible(
  ctx: RecordingToolContext,
  owner: string | undefined,
  deviceId: string,
  requesterSessionUuid: string | undefined,
  requesterMcpSessionId: string | undefined,
): boolean {
  if (owner === undefined || requesterSessionUuid === undefined) {
    return true;
  }
  const requesterBase = ctx.requesterResolver.baseSessionUuid(requesterSessionUuid);
  const ownerBase = ctx.requesterResolver.baseSessionUuid(owner);
  return (
    ownerVisibleInScope(owner, {
      ownerSessionUuid: requesterSessionUuid,
      ownerBaseSessionUuid: requesterBase,
    }) ||
    ownerBase === requesterBase ||
    (requesterMcpSessionId !== undefined &&
      ctx.requesterResolver.connectionOwnsDeviceSession(requesterMcpSessionId, deviceId, ownerBase))
  );
}

/** The finalized row's metadata, owner-scoped in the query itself (#11533). */
async function getFinalizedMetadata(
  ctx: RecordingToolContext,
  recordingId: string,
  requesterSessionUuid: string | undefined,
  requesterMcpSessionId: string | undefined,
) {
  if (requesterSessionUuid === undefined) {
    return getVideoRecordingMetadata(recordingId);
  }
  const metadata = await getVideoRecordingMetadata(recordingId, {
    ownerSessionUuid: requesterSessionUuid,
    ownerBaseSessionUuid: ctx.requesterResolver.baseSessionUuid(requesterSessionUuid),
  });
  if (metadata || requesterMcpSessionId === undefined) {
    return metadata;
  }
  // The requester's connection may hold the device session of the owner's base: learn the owner
  // from the row's header, then re-query scoped to exactly that owner.
  const ref = await getVideoRecordingOwnerRef(recordingId);
  if (
    ref?.ownerSessionUuid === undefined ||
    !finalizedOwnerVisible(
      ctx,
      ref.ownerSessionUuid,
      ref.deviceId,
      requesterSessionUuid,
      requesterMcpSessionId,
    )
  ) {
    return null;
  }
  return getVideoRecordingMetadata(recordingId, { ownerSessionUuid: ref.ownerSessionUuid });
}

async function finalizedStopResponse(
  ctx: RecordingToolContext,
  recordingId: string,
  ownerSessionUuid?: string,
  requesterMcpSessionId?: string,
) {
  const finishedSegmented = segmentedSessions.getFinished(recordingId, (owner, deviceId) =>
    finalizedOwnerVisible(ctx, owner, deviceId, ownerSessionUuid, requesterMcpSessionId),
  );
  if (finishedSegmented) {
    return segmentedStopResponse(finishedSegmented);
  }
  const metadata = await getFinalizedMetadata(
    ctx,
    recordingId,
    ownerSessionUuid,
    requesterMcpSessionId,
  );
  if (!metadata) {
    return null;
  }
  return createStructuredToolResponse({
    action: "stop",
    count: 1,
    recordings: [stopResultEntry(metadata)],
    alreadyStopped: true,
  });
}

function startupOrphanStopWarning(
  planned: VideoRecordingRecord | null,
  descriptor: VideoRecordingRecord["captureTeardown"],
  adopted: VideoRecordingMetadata | undefined,
  metadata: VideoRecordingMetadata,
): string {
  let warning = "The capture was interrupted by a daemon restart and its recorder was stopped.";
  if (adopted) {
    warning += ` The planned .${planned!.format} was never written; the raw .${adopted.format} capture is returned instead.`;
  } else if (descriptor?.kind === "ios-host-recorder" && metadata.sizeBytes === 0) {
    warning += " No recording file was found.";
  }
  return warning;
}

export async function tryStopStartupOrphan(
  ctx: RecordingToolContext,
  recordingId: string,
  ownerSessionUuid?: string,
  requesterMcpSessionId?: string,
) {
  if (heldVideoRecordingOwner(recordingId) !== undefined) {
    return undefined;
  }
  const orphans = getStartupOrphanCaptures();
  const orphan = orphans?.find(recordingId);
  if (orphan) {
    assertActiveRecordingOwner(ctx, {
      recordingId,
      deviceId: orphan.deviceId,
      recordingOwner: orphan.ownerSessionUuid,
      requesterSessionUuid: ownerSessionUuid,
      requesterMcpSessionId,
    });
    const { recordingRepository } = await initializeRecordingTeardownRedriveState();
    // Stopping acknowledges and clears the descriptor, so retain its raw artifact path first.
    const planned = await recordingRepository.getRecording(recordingId);
    const descriptor = planned?.captureTeardown;
    const capturePath =
      descriptor?.kind === "ios-host-recorder" ? descriptor.capturePath : undefined;
    try {
      await orphans!.stop(orphan.deviceId, recordingId);
    } catch (error) {
      throw new OrphanRecorderActiveError(orphan.deviceId, [recordingId], error);
    }
    await interruptVideoRecording(recordingId);
    const adopted = capturePath
      ? await adoptOrphanCaptureArtifact(recordingId, capturePath)
      : undefined;
    const metadata = adopted ?? (await getVideoRecordingMetadata(recordingId));
    const row = await recordingRepository.getRecording(recordingId);
    if (!metadata || !row) {
      throw new ActionableError(
        `Stopped startup recorder ${recordingId} has no persisted metadata.`,
      );
    }
    return {
      ...stopResultEntry(metadata, row),
      status: "interrupted",
      warning: startupOrphanStopWarning(planned, descriptor, adopted, metadata),
    };
  }
  return undefined;
}

export async function stopRecordingById(
  ctx: RecordingToolContext,
  recordingId: string,
  ownerSessionUuid?: string,
  requesterMcpSessionId?: string,
) {
  const segmented = await tryStopSegmentedSession(
    ctx,
    recordingId,
    ownerSessionUuid,
    requesterMcpSessionId,
  );
  if (segmented) {
    return segmented;
  }

  const results: Array<Record<string, unknown>> = [];
  const evictedRecordingIds: string[] = [];
  const stoppedOrphan = await tryStopStartupOrphan(
    ctx,
    recordingId,
    ownerSessionUuid,
    requesterMcpSessionId,
  );
  if (stoppedOrphan) {
    return createStructuredToolResponse({ action: "stop", count: 1, recordings: [stoppedOrphan] });
  }
  const heldOwner = heldVideoRecordingOwner(recordingId);
  const activeRecords = await listActiveVideoRecordings();
  const matching = activeRecords.find((record) => record.recordingId === recordingId);
  const captureOwner = heldOwner ?? matching;
  if (captureOwner) {
    // An interrupted row can still have a live capture. Its in-memory owner wins, including
    // an explicitly ownerless capture; consult the row only when no memory entry exists.
    const owner =
      "deviceId" in captureOwner ? captureOwner : await getVideoRecordingOwnerRef(recordingId);
    if (owner?.deviceId !== undefined) {
      assertActiveRecordingOwner(ctx, {
        recordingId,
        deviceId: owner.deviceId,
        recordingOwner: owner.ownerSessionUuid,
        requesterSessionUuid: ownerSessionUuid,
        requesterMcpSessionId,
      });
    }
  } else {
    // No held capture or recording row: finalized-artifact reads stop nothing (#11647).
    // Sessions require finalizedOwnerVisible (owner, same base, or acquiring connection);
    // sessionless requesters and ownerless rows retain their unscoped read access.
    const finalized = await finalizedStopResponse(
      ctx,
      recordingId,
      ownerSessionUuid,
      requesterMcpSessionId,
    );
    if (finalized) {
      return finalized;
    }
  }

  try {
    const { metadata, evictedRecordingIds: evicted } = await stopVideoRecording(recordingId);
    results.push(stopResultEntry(metadata, matching));

    for (const evictedId of evicted) {
      evictedRecordingIds.push(evictedId);
    }
  } catch (error) {
    throw toActionableError(error, `Failed to stop video recording`);
  }

  return createStructuredToolResponse({
    action: "stop",
    count: results.length,
    recordings: results,
    evictedRecordingIds: evictedRecordingIds.length > 0 ? evictedRecordingIds : undefined,
  });
}
