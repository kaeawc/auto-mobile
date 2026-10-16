package dev.jasonpearson.automobile.ctrlproxy

import android.content.ClipData
import android.content.ClipboardManager
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.put

/** Clipboard copy/get/clear/paste requests, with platform and socket access supplied per call. */
internal class ClipboardController(
  private val clipboardManager: () -> ClipboardManager,
  private val activeWindowRoot: () -> AccessibilityNodeInfo?,
  private val perfProvider: PerfProvider,
  private val timeProvider: TimeProvider,
  private val resultBroadcaster: ResultBroadcaster,
  private val responseSender: ResponseSender,
) {
  /** Keeps the service's frame encoder and late-bound WebSocket server behind one seam. */
  interface ResponseSender {
    fun isRunning(): Boolean

    suspend fun broadcastWithPerf(
      type: String,
      requestId: String?,
      buildContent: JsonObjectBuilder.() -> Unit,
    )

    fun connectionCount(): Int
  }

  companion object {
    private const val TAG = "CtrlProxy"
  }

  /**
   * Perform clipboard operations using ClipboardManager and AccessibilityService. Supports copy,
   * paste, clear, and get operations.
   */
  suspend fun performClipboard(requestId: String?, action: String, text: String?) {
    val startTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "performClipboard: action='$action'")
    perfProvider.serial("performClipboard")

    try {
      perfProvider.startOperation("executeClipboardAction")

      val (success, resultText, error) =
        when (action) {
          "copy" -> {
            if (text == null || text.isEmpty()) {
              Triple(false, null, "Text is required for copy action")
            } else {
              try {
                val clip = ClipData.newPlainText("AutoMobile", text)
                clipboardManager().setPrimaryClip(clip)
                Log.d(TAG, "Clipboard copy successful (${text.length} chars)")
                Triple(true, null, null)
              } catch (e: CancellationException) {
                throw e
              } catch (e: Exception) {
                Log.e(TAG, "Clipboard copy failed", e)
                Triple(false, null, "Copy failed: ${e.message}")
              }
            }
          }
          "get" -> {
            try {
              val readResult =
                CtrlProxyClipboard.readResultFromPrimaryClip(clipboardManager().primaryClip)
              if (readResult.success) {
                val clipText = readResult.text ?: ""
                if (clipText.isEmpty()) {
                  Log.d(TAG, "Clipboard is empty")
                } else {
                  Log.d(TAG, "Clipboard get successful (${clipText.length} chars)")
                }
                Triple(true, clipText, null)
              } else {
                val readError = readResult.error ?: "Clipboard read failed"
                Log.w(TAG, readError)
                Triple(false, null, readError)
              }
            } catch (e: CancellationException) {
              throw e
            } catch (e: Exception) {
              Log.e(TAG, "Clipboard get failed", e)
              Triple(false, null, "Get failed: ${e.message}")
            }
          }
          "clear" -> {
            try {
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                clipboardManager().clearPrimaryClip()
                Log.d(TAG, "Clipboard cleared using clearPrimaryClip()")
              } else {
                // Fallback for API < 28: set empty clip
                val emptyClip = ClipData.newPlainText("", "")
                clipboardManager().setPrimaryClip(emptyClip)
                Log.d(TAG, "Clipboard cleared using empty clip (API < 28)")
              }
              Triple(true, null, null)
            } catch (e: CancellationException) {
              throw e
            } catch (e: Exception) {
              Log.e(TAG, "Clipboard clear failed", e)
              Triple(false, null, "Clear failed: ${e.message}")
            }
          }
          "paste" -> {
            try {
              perfProvider.startOperation("findFocusedNode")
              val focusedNode = findFocusedEditableNode(activeWindowRoot())
              perfProvider.endOperation("findFocusedNode")

              if (focusedNode == null) {
                Log.w(TAG, "No focused editable node found for paste")
                Triple(
                  false,
                  null,
                  "No focused input field found. Focus a text field before pasting.",
                )
              } else {
                perfProvider.startOperation("performPaste")
                val pasteSuccess =
                  focusedNode.performAction(
                    AccessibilityNodeInfo.ACTION_PASTE,
                  )
                focusedNode.recycle()
                perfProvider.endOperation("performPaste")

                if (pasteSuccess) {
                  Log.d(TAG, "Clipboard paste successful")
                  Triple(true, null, null)
                } else {
                  Log.w(TAG, "Paste action returned false")
                  Triple(false, null, "Paste action failed")
                }
              }
            } catch (e: CancellationException) {
              throw e
            } catch (e: Exception) {
              Log.e(TAG, "Clipboard paste failed", e)
              Triple(false, null, "Paste failed: ${e.message}")
            }
          }
          else -> {
            Log.w(TAG, "Unknown clipboard action: $action")
            Triple(false, null, "Unknown action: $action")
          }
        }

      perfProvider.endOperation("executeClipboardAction")
      perfProvider.end()

      Log.d(TAG, "Clipboard action completed: action=$action, success=$success")

      val totalTime = timeProvider.currentTimeMillis() - startTime
      Log.d(TAG, "Clipboard total time: ${totalTime}ms")

      // Broadcast clipboard result
      broadcastClipboardResult(requestId, action, success, resultText, error, totalTime)
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing clipboard operation", e)
      broadcastClipboardResult(requestId, action, false, null, e.message, errorTime - startTime)
    }
  }

  /** Broadcast clipboard result to WebSocket clients */
  private suspend fun broadcastClipboardResult(
    requestId: String?,
    action: String,
    success: Boolean,
    text: String?,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping clipboard result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "clipboard_result") {
      responseSender.broadcastWithPerf("clipboard_result", requestId) {
        put("action", action)
        put("success", success)
        put("totalTimeMs", totalTimeMs)
        if (text != null) {
          put("text", text)
        }
        if (error != null) {
          put("error", error)
        }
      }
      Log.d(TAG, "Broadcasted clipboard result to ${responseSender.connectionCount()} clients")
    }
  }
}
