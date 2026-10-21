package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.ctrlproxy.models.TraversalOrderResult
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.TraversalOrderData
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer

/**
 * Accessibility focus, TalkBack traversal order and highlight overlay requests. Everything that
 * needs the live accessibility service or the late-bound WebSocket server comes through [Host] and
 * [ResultSender].
 */
internal class FocusController(
  private val host: Host,
  private val perfProvider: PerfProvider,
  private val timeProvider: TimeProvider,
  private val jsonCompact: Json,
  private val resultSender: ResultSender,
) {
  /** Service-side operations the controller cannot perform without the accessibility service. */
  interface Host {
    fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit)

    /** The node holding accessibility focus in any window of the active display, if any. */
    fun findAccessibilityFocusedNode(): AccessibilityNodeInfo?

    fun extractFocusedElementInfo(node: AccessibilityNodeInfo): UIElementInfo?

    /** Null when neither windows nor an active root are available. */
    fun extractTraversalOrder(): TraversalOrderResult?

    /** Null until the overlay drawer is initialized. */
    fun currentOverlayDrawer(): OverlayDrawer?
  }

  companion object {
    private const val TAG = "CtrlProxy"
  }

  /**
   * Get the current accessibility focus element. Returns the element that currently has
   * accessibility focus (TalkBack cursor position).
   */
  fun handleGetCurrentFocus(requestId: String?) {
    val startTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "handleGetCurrentFocus (requestId: $requestId)")
    perfProvider.serial("getCurrentFocus")

    try {
      perfProvider.startOperation("findFocus")
      val focusedNode = host.findAccessibilityFocusedNode()
      perfProvider.endOperation("findFocus")

      if (focusedNode == null) {
        perfProvider.end()
        val totalTime = timeProvider.currentTimeMillis() - startTime
        Log.d(TAG, "No accessibility focus found")
        host.launchRequestScope(requestId) {
          broadcastCurrentFocusResult(requestId, null, totalTime)
        }
        return
      }

      perfProvider.startOperation("extractFocusInfo")
      // Extract focus element information
      val focusedElement = host.extractFocusedElementInfo(focusedNode)
      focusedNode.recycle()
      perfProvider.endOperation("extractFocusInfo")
      perfProvider.end()

      val totalTime = timeProvider.currentTimeMillis() - startTime
      Log.d(TAG, "Current focus extracted in ${totalTime}ms")

      host.launchRequestScope(requestId) {
        broadcastCurrentFocusResult(requestId, focusedElement, totalTime)
      }
    } catch (e: IllegalArgumentException) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error getting current focus", e)
      host.launchRequestScope(requestId) {
        broadcastCurrentFocusError(requestId, e.message, errorTime - startTime)
      }
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error getting current focus", e)
      host.launchRequestScope(requestId) {
        broadcastCurrentFocusError(requestId, e.message, errorTime - startTime)
      }
    } catch (e: SecurityException) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error getting current focus", e)
      host.launchRequestScope(requestId) {
        broadcastCurrentFocusError(requestId, e.message, errorTime - startTime)
      }
    }
  }

  /**
   * Get the traversal order of focusable elements. Returns an ordered list of all
   * accessibility-focusable elements in TalkBack traversal order.
   */
  fun handleGetTraversalOrder(requestId: String?) {
    val startTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "handleGetTraversalOrder (requestId: $requestId)")
    perfProvider.serial("getTraversalOrder")

    try {
      perfProvider.startOperation("extractTraversalOrder")
      val traversalResult = host.extractTraversalOrder()

      if (traversalResult == null) {
        perfProvider.endOperation("extractTraversalOrder")
        perfProvider.end()
        val totalTime = timeProvider.currentTimeMillis() - startTime
        Log.w(TAG, "No windows or root node available for traversal order extraction")
        host.launchRequestScope(requestId) {
          broadcastTraversalOrderError(requestId, "No windows available", totalTime)
        }
        return
      }
      perfProvider.endOperation("extractTraversalOrder")
      perfProvider.end()

      val totalTime = timeProvider.currentTimeMillis() - startTime
      Log.d(
        TAG,
        "Traversal order extracted: ${traversalResult.elements.size} elements in ${totalTime}ms",
      )

      host.launchRequestScope(requestId) {
        broadcastTraversalOrderResult(requestId, traversalResult, totalTime)
      }
    } catch (e: IllegalArgumentException) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error getting traversal order", e)
      host.launchRequestScope(requestId) {
        broadcastTraversalOrderError(requestId, e.message, errorTime - startTime)
      }
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error getting traversal order", e)
      host.launchRequestScope(requestId) {
        broadcastTraversalOrderError(requestId, e.message, errorTime - startTime)
      }
    } catch (e: SecurityException) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error getting traversal order", e)
      host.launchRequestScope(requestId) {
        broadcastTraversalOrderError(requestId, e.message, errorTime - startTime)
      }
    }
  }

  fun handleAddHighlight(
    requestId: String?,
    highlightId: String?,
    shape: HighlightShape?,
  ) {
    host.launchRequestScope(requestId) {
      val drawer = host.currentOverlayDrawer()
      if (drawer == null) {
        broadcastHighlightResponse(requestId, false, "Overlay drawer not initialized")
        return@launchRequestScope
      }

      val result =
        try {
          withContext(Dispatchers.Main) { drawer.addHighlight(highlightId, shape) }
        } catch (e: CancellationException) {
          // Let cooperative cancellation unwind cleanly rather than reporting a failed highlight
          // result (#3130).
          throw e
        } catch (e: IllegalArgumentException) {
          HighlightOperationResult(false, e.message ?: "Failed to add highlight")
        } catch (e: IllegalStateException) {
          HighlightOperationResult(false, e.message ?: "Failed to add highlight")
        } catch (e: SecurityException) {
          HighlightOperationResult(false, e.message ?: "Failed to add highlight")
        } catch (e: android.view.WindowManager.BadTokenException) {
          HighlightOperationResult(false, e.message ?: "Failed to add highlight")
        } catch (e: android.view.WindowManager.InvalidDisplayException) {
          HighlightOperationResult(false, e.message ?: "Failed to add highlight")
        }

      broadcastHighlightResponse(requestId, result.success, result.error)
    }
  }

  private suspend fun broadcastHighlightResponse(
    requestId: String?,
    success: Boolean,
    error: String?,
  ) {
    resultSender.sendFrame(requestId, "highlight_response") { perfTiming ->
      highlightResponseFrame(
        timeProvider.currentTimeMillis(),
        requestId,
        success,
        error,
        perfTiming,
      )
    }
  }

  /** Broadcast current focus result to WebSocket clients */
  private suspend fun broadcastCurrentFocusResult(
    requestId: String?,
    focusedElement: UIElementInfo?,
    totalTimeMs: Long,
  ) {
    resultSender.sendFrame(requestId, "current_focus_result") { perfTiming ->
      val elementJson = focusedElement?.let {
        jsonCompact.encodeToString(serializer<UIElementInfo>(), it)
      }
      currentFocusResultFrame(
        timeProvider.currentTimeMillis(),
        requestId,
        totalTimeMs,
        elementJson,
        perfTiming,
      )
    }
  }

  /** Broadcast current focus error to WebSocket clients */
  private suspend fun broadcastCurrentFocusError(
    requestId: String?,
    error: String?,
    totalTimeMs: Long,
  ) {
    resultSender.sendFrame(requestId, "current_focus_error", attachPerf = false) { _ ->
      currentFocusErrorFrame(requestId, error, totalTimeMs)
    }
  }

  /** Broadcast traversal order result to WebSocket clients */
  private suspend fun broadcastTraversalOrderResult(
    requestId: String?,
    traversalResult: TraversalOrderResult,
    totalTimeMs: Long,
  ) {
    resultSender.sendFrame(requestId, "traversal_order_result") { perfTiming ->
      val result =
        TraversalOrderData(
          elements =
            traversalResult.elements.map {
              jsonCompact.encodeToString(serializer<UIElementInfo>(), it)
            },
          focusedIndex = traversalResult.focusedIndex,
          totalCount = traversalResult.totalCount,
          truncationReasons = traversalResult.truncationReasons,
        )
      traversalOrderResultFrame(
        timeProvider.currentTimeMillis(),
        requestId,
        totalTimeMs,
        result,
        perfTiming,
      )
    }
  }

  /** Broadcast traversal order error to WebSocket clients */
  private suspend fun broadcastTraversalOrderError(
    requestId: String?,
    error: String?,
    totalTimeMs: Long,
  ) {
    resultSender.sendFrame(requestId, "traversal_order_error", attachPerf = false) { _ ->
      traversalOrderErrorFrame(requestId, error, totalTimeMs)
    }
  }
}
