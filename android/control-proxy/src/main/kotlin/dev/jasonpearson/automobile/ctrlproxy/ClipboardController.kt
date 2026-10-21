package dev.jasonpearson.automobile.ctrlproxy

import android.content.ClipData
import android.content.ClipboardManager
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import kotlinx.coroutines.CancellationException

/** Clipboard copy/get/clear/paste requests, with platform and socket access supplied per call. */
internal class ClipboardController(
  private val clipboardManager: () -> ClipboardManager,
  private val activeWindowRoot: () -> AccessibilityNodeInfo?,
  private val perfProvider: PerfProvider,
  private val timeProvider: TimeProvider,
  private val resultSender: ResultSender,
) {
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
          "copy" -> copyClipboard(text)
          "get" -> getClipboard()
          "clear" -> clearClipboard()
          "paste" -> pasteClipboard()
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
      broadcastClipboardResult(
        ClipboardFrameResult(requestId, action, success, resultText, error, totalTime),
      )
    } catch (e: CancellationException) {
      throw e
    } catch (e: java.io.IOException) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing clipboard operation", e)
      broadcastClipboardResult(
        ClipboardFrameResult(requestId, action, false, null, e.message, errorTime - startTime),
      )
    } catch (e: IllegalArgumentException) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing clipboard operation", e)
      broadcastClipboardResult(
        ClipboardFrameResult(requestId, action, false, null, e.message, errorTime - startTime),
      )
    } catch (e: IllegalStateException) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing clipboard operation", e)
      broadcastClipboardResult(
        ClipboardFrameResult(requestId, action, false, null, e.message, errorTime - startTime),
      )
    } catch (e: SecurityException) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing clipboard operation", e)
      broadcastClipboardResult(
        ClipboardFrameResult(requestId, action, false, null, e.message, errorTime - startTime),
      )
    }
  }

  private fun copyClipboard(text: String?): Triple<Boolean, String?, String?> {
    return if (text == null || text.isEmpty()) {
      Triple(false, null, "Text is required for copy action")
    } else {
      try {
        val clip = ClipData.newPlainText("AutoMobile", text)
        clipboardManager().setPrimaryClip(clip)
        Log.d(TAG, "Clipboard copy successful (${text.length} chars)")
        Triple(true, null, null)
      } catch (e: CancellationException) {
        throw e
      } catch (e: SecurityException) {
        Log.e(TAG, "Clipboard copy failed", e)
        Triple(false, null, "Copy failed: ${e.message}")
      } catch (e: IllegalStateException) {
        Log.e(TAG, "Clipboard copy failed", e)
        Triple(false, null, "Copy failed: ${e.message}")
      } catch (e: IllegalArgumentException) {
        Log.e(TAG, "Clipboard copy failed", e)
        Triple(false, null, "Copy failed: ${e.message}")
      }
    }
  }

  private fun getClipboard(): Triple<Boolean, String?, String?> {
    return try {
      val readResult = CtrlProxyClipboard.readResultFromPrimaryClip(clipboardManager().primaryClip)
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
    } catch (e: SecurityException) {
      Log.e(TAG, "Clipboard get failed", e)
      Triple(false, null, "Get failed: ${e.message}")
    } catch (e: IllegalStateException) {
      Log.e(TAG, "Clipboard get failed", e)
      Triple(false, null, "Get failed: ${e.message}")
    }
  }

  private fun clearClipboard(): Triple<Boolean, String?, String?> {
    return try {
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
    } catch (e: SecurityException) {
      Log.e(TAG, "Clipboard clear failed", e)
      Triple(false, null, "Clear failed: ${e.message}")
    } catch (e: IllegalStateException) {
      Log.e(TAG, "Clipboard clear failed", e)
      Triple(false, null, "Clear failed: ${e.message}")
    } catch (e: IllegalArgumentException) {
      Log.e(TAG, "Clipboard clear failed", e)
      Triple(false, null, "Clear failed: ${e.message}")
    }
  }

  private fun pasteClipboard(): Triple<Boolean, String?, String?> {
    return try {
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
    } catch (e: IllegalStateException) {
      Log.e(TAG, "Clipboard paste failed", e)
      Triple(false, null, "Paste failed: ${e.message}")
    } catch (e: IllegalArgumentException) {
      Log.e(TAG, "Clipboard paste failed", e)
      Triple(false, null, "Paste failed: ${e.message}")
    } catch (e: SecurityException) {
      Log.e(TAG, "Clipboard paste failed", e)
      Triple(false, null, "Paste failed: ${e.message}")
    }
  }

  /** Broadcast clipboard result to WebSocket clients */
  private suspend fun broadcastClipboardResult(outcome: ClipboardFrameResult) {
    resultSender.sendFrame(outcome.requestId, "clipboard_result") { perfTiming ->
      clipboardResultFrame(outcome, perfTiming)
    }
  }
}
