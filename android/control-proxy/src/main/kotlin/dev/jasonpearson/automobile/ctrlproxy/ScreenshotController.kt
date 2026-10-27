package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService.ScreenshotResult
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback
import android.graphics.Bitmap
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.annotation.RequiresApi
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

internal data class ScreenshotCapturePayload(
  val base64Image: String,
  val rotation: Int?,
  val displayId: Int,
  val panelUniqueId: String?,
  val captureDurationMs: Long,
  val encodeDurationMs: Long,
  val byteLength: Int,
  val base64Length: Int,
)

/** Raw result of the platform takeScreenshot callback, carrying the failure code (issue #4927). */
internal sealed interface ScreenshotCallbackResult {
  data class Captured(val bitmap: Bitmap, val rotation: Int?) : ScreenshotCallbackResult

  data class Failed(val errorCode: Int?) : ScreenshotCallbackResult
}

/**
 * Outcome of [takeScreenshotAsync]: an encoded payload, or a failure that retains the platform
 * error code so the broadcast can surface a rate limit distinctly instead of a generic failure.
 */
internal sealed interface ScreenshotCaptureOutcome {
  data class Success(val payload: ScreenshotCapturePayload) : ScreenshotCaptureOutcome

  data class Failure(val errorCode: Int?) : ScreenshotCaptureOutcome
}

/**
 * Screenshot capture: the platform takeScreenshot call, rotation provenance around it, and JPEG
 * encoding. Broadcasting the result stays in CtrlProxy. Everything that needs the live
 * accessibility service comes through [Host]; capture and encode durations are measured with the
 * injected [TimeProvider].
 */
internal class ScreenshotController(
  private val host: Host,
  private val displayController: DisplayController,
  private val timeProvider: TimeProvider,
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
  /** Service-side operations the controller cannot perform without the accessibility service. */
  interface Host {
    /** `AccessibilityService.takeScreenshot` on the service's main executor (API 30+). */
    @RequiresApi(Build.VERSION_CODES.R)
    fun takeScreenshot(displayId: Int, callback: TakeScreenshotCallback)

    /** The display-change tracker, bound once the service connects. */
    fun rotationProvenance(): RotationProvenanceTracker
  }

  companion object {
    private const val TAG = "CtrlProxy"
  }

  /**
   * Takes a screenshot and returns it as a base64-encoded JPEG plus capture diagnostics. Requires
   * Android R (API 30) or higher. Runs on IO dispatcher to avoid blocking the main thread.
   */
  suspend fun takeScreenshotAsync(
    targetDisplayId: Int,
    quality: Int = 80,
  ): ScreenshotCaptureOutcome {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      Log.w(TAG, "Screenshot API requires Android R (API 30) or higher")
      return ScreenshotCaptureOutcome.Failure(null)
    }

    return withContext(ioDispatcher) {
      try {
        val startTime = timeProvider.currentTimeMillis()

        val captured = captureBitmap(targetDisplayId)

        if (captured is ScreenshotCallbackResult.Failed) {
          Log.e(
            TAG,
            "Failed to capture screenshot bitmap (errorCode=${captured.errorCode})",
          )
          return@withContext ScreenshotCaptureOutcome.Failure(captured.errorCode)
        }

        val bitmap = (captured as ScreenshotCallbackResult.Captured).bitmap

        val screenshotTime = timeProvider.currentTimeMillis() - startTime
        Log.d(
          TAG,
          "Screenshot captured in ${screenshotTime}ms (${bitmap.width}x${bitmap.height})",
        )

        encodeScreenshot(captured, targetDisplayId, quality, startTime, screenshotTime)
      } catch (e: CancellationException) {
        // The awaiting caller is being cancelled — rethrow instead of converting the
        // cancellation
        // into a null screenshot (#3191).
        throw e
      } catch (e: IllegalArgumentException) {
        Log.e(TAG, "Error taking screenshot", e)
        ScreenshotCaptureOutcome.Failure(null)
      } catch (e: IllegalStateException) {
        Log.e(TAG, "Error taking screenshot", e)
        ScreenshotCaptureOutcome.Failure(null)
      } catch (e: SecurityException) {
        Log.e(TAG, "Error taking screenshot", e)
        ScreenshotCaptureOutcome.Failure(null)
      }
    }
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private suspend fun captureBitmap(targetDisplayId: Int): ScreenshotCallbackResult {
    // Use suspendCancellableCoroutine to bridge callback-based API
    val rotationProvenance = host.rotationProvenance()
    val rotationCapture = rotationProvenance.beginCapture(targetDisplayId)
    val rotationAtCaptureStart = displayController.getRotationOrNull(targetDisplayId)
    return suspendCancellableCoroutine<ScreenshotCallbackResult> { continuation ->
      host.takeScreenshot(
        targetDisplayId,
        object : TakeScreenshotCallback {
          override fun onSuccess(screenshot: ScreenshotResult) {
            val hardwareBitmap =
              Bitmap.wrapHardwareBuffer(
                screenshot.hardwareBuffer,
                screenshot.colorSpace,
              )
            screenshot.hardwareBuffer.close()
            if (hardwareBitmap == null) {
              continuation.resume(ScreenshotCallbackResult.Failed(null))
              return
            }
            // A display change makes the pixels' orientation ambiguous.
            // Preserve that
            // ambiguity as null so desktop control fails closed rather than
            // guessing.
            val rotation =
              rotationProvenance.rotationIfUnchanged(
                rotationCapture,
                rotationAtCaptureStart,
                displayController.getRotationOrNull(
                  targetDisplayId,
                ),
                targetDisplayId,
              )
            continuation.resume(
              ScreenshotCallbackResult.Captured(hardwareBitmap, rotation),
            )
          }

          override fun onFailure(errorCode: Int) {
            // Retain the platform error code so the broadcast can
            // distinguish a rate limit
            // (ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) from a real
            // failure (issue #4927).
            Log.e(TAG, "Screenshot failed with error code: $errorCode")
            continuation.resume(ScreenshotCallbackResult.Failed(errorCode))
          }
        },
      )
    }
  }

  private fun encodeScreenshot(
    captured: ScreenshotCallbackResult.Captured,
    targetDisplayId: Int,
    quality: Int,
    startTime: Long,
    screenshotTime: Long,
  ): ScreenshotCaptureOutcome {
    val (bitmap, rotation) = captured
    // Convert to JPEG bytes on IO thread
    val encodeStart = timeProvider.currentTimeMillis()
    val outputStream = ByteArrayOutputStream()

    // Convert hardware bitmap to software bitmap for compression
    val softwareBitmap = bitmap.copy(Bitmap.Config.ARGB_8888, false)
    bitmap.recycle()

    softwareBitmap.compress(Bitmap.CompressFormat.JPEG, quality, outputStream)
    softwareBitmap.recycle()

    val jpegBytes = outputStream.toByteArray()
    val base64String = Base64.encodeToString(jpegBytes, Base64.NO_WRAP)

    val encodeTime = timeProvider.currentTimeMillis() - encodeStart
    val totalTime = timeProvider.currentTimeMillis() - startTime

    Log.d(
      TAG,
      "Screenshot encoded: ${jpegBytes.size} bytes -> ${base64String.length} base64 chars in ${encodeTime}ms (total: ${totalTime}ms)",
    )

    return ScreenshotCaptureOutcome.Success(
      ScreenshotCapturePayload(
        base64Image = base64String,
        rotation = rotation,
        displayId = targetDisplayId,
        panelUniqueId = displayController.panelUniqueId(targetDisplayId),
        captureDurationMs = screenshotTime,
        encodeDurationMs = encodeTime,
        byteLength = jpegBytes.size,
        base64Length = base64String.length,
      ),
    )
  }
}
