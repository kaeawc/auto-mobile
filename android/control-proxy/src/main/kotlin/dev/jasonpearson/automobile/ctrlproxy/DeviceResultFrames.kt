package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.CaCertResult
import dev.jasonpearson.automobile.protocol.ClipboardResult
import dev.jasonpearson.automobile.protocol.DeviceOwnerStatusResult
import dev.jasonpearson.automobile.protocol.ImeActionResult
import dev.jasonpearson.automobile.protocol.ScreenshotErrorResult
import dev.jasonpearson.automobile.protocol.SelectAllResult
import kotlinx.serialization.json.JsonElement

internal fun clipboardResultFrame(outcome: ClipboardFrameResult, perfTiming: JsonElement?): String =
  typedResultFrame(
    ClipboardResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      action = outcome.action,
      success = outcome.success,
      totalTimeMs = outcome.totalTimeMs,
      text = outcome.text,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun caCertResultFrame(outcome: CaCertificateResult, perfTiming: JsonElement?): String =
  typedResultFrame(
    CaCertResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      action = outcome.action,
      success = outcome.success,
      totalTimeMs = outcome.totalTimeMs,
      alias = outcome.alias,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun deviceOwnerStatusResultFrame(
  outcome: DeviceOwnerResult,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    DeviceOwnerStatusResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      success = outcome.error == null,
      totalTimeMs = outcome.totalTimeMs,
      packageName = outcome.packageName,
      isDeviceOwner = outcome.isDeviceOwner,
      isAdminActive = outcome.isAdminActive,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun imeActionResultFrame(outcome: ImeActionFrameResult, perfTiming: JsonElement?): String =
  typedResultFrame(
    ImeActionResult(
      timestamp = System.currentTimeMillis(),
      requestId = outcome.requestId,
      approximated = outcome.approximated,
      action = outcome.action,
      success = outcome.success,
      totalTimeMs = outcome.totalTimeMs,
      error = outcome.error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun selectAllResultFrame(
  requestId: String?,
  success: Boolean,
  error: String?,
  totalTimeMs: Long,
  perfTiming: JsonElement?,
): String =
  typedResultFrame(
    SelectAllResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      success = success,
      totalTimeMs = totalTimeMs,
      error = error,
      perfTiming = perfTiming?.toString(),
    ),
  )

internal fun screenshotErrorFrame(
  requestId: String?,
  error: String,
  displayId: Int? = null,
  panelUniqueId: String? = null,
): String =
  typedResultFrame(
    ScreenshotErrorResult(
      timestamp = System.currentTimeMillis(),
      requestId = requestId,
      error = error,
      displayId = displayId,
      panelUniqueId = panelUniqueId,
    ),
  )
