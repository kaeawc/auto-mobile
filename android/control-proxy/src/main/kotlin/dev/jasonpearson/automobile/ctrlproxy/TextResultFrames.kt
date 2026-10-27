package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.CancelImeCommitResult
import dev.jasonpearson.automobile.protocol.CommitTextResult
import dev.jasonpearson.automobile.protocol.CurrentFocusResult
import dev.jasonpearson.automobile.protocol.KeyboardProfileCatalogResult
import dev.jasonpearson.automobile.protocol.SetTextResult
import dev.jasonpearson.automobile.protocol.TraversalOrderResult
import kotlinx.serialization.json.JsonElement

internal fun setTextResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  totalTimeMs: Long,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    SetTextResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = success,
      totalTimeMs = totalTimeMs,
      error = error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun commitTextResultFrame(
  outcome: CommitTextFrameResult,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    CommitTextResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      success = outcome.success,
      totalTimeMs = outcome.totalTimeMs,
      partialApplication = outcome.partialApplication,
      committedUnits = outcome.committedUnits,
      insertedText = outcome.insertedText,
      editorConsumed = outcome.editorConsumed,
      trace = outcome.trace,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun cancelImeCommitResultFrame(
  requestId: String?,
  targetRequestId: String,
  partialApplication: Boolean,
  committedUnits: Int,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    CancelImeCommitResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      targetRequestId = targetRequestId,
      partialApplication = partialApplication,
      committedUnits = committedUnits,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun keyboardProfilesResultFrame(
  outcome: KeyboardProfilesResult,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    KeyboardProfileCatalogResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      success = outcome.success,
      catalogId = "automobile_behavior_profiles",
      catalogVersion = outcome.catalogVersion,
      supportedCatalogVersions = outcome.supportedCatalogVersions,
      activeProfileId = outcome.activeProfileId,
      profiles = if (outcome.success) outcome.profiles else null,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun currentFocusErrorFrame(
  requestId: String?,
  error: String?,
  totalTimeMs: Long,
): String =
  typedResultFrame(
    CurrentFocusResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      totalTimeMs = totalTimeMs,
      error = error ?: "Unknown error",
    ),
  )

internal fun traversalOrderErrorFrame(
  requestId: String?,
  error: String?,
  totalTimeMs: Long,
): String =
  typedResultFrame(
    TraversalOrderResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      totalTimeMs = totalTimeMs,
      error = error ?: "Unknown error",
    ),
  )
