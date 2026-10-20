package dev.jasonpearson.automobile.ctrlproxy

import android.os.Build
import android.text.Spanned
import android.text.style.ClickableSpan
import android.util.Log
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.NodeSelector
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope

/**
 * Accessibility node actions (click, scroll, focus, ...) and semantic accessibility-link
 * activation. Everything that needs the live accessibility service comes through [Host].
 */
internal class NodeActionController(
  private val host: Host,
  private val perfProvider: PerfProvider,
  private val timeProvider: TimeProvider,
) {
  /** Service-side operations the controller cannot perform without the accessibility service. */
  interface Host {
    fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit)

    fun activeWindowRoot(): AccessibilityNodeInfo?

    /** Searches the active window first, then the other windows of the active display. */
    fun findNodeInDisplayWindows(
      find: (AccessibilityNodeInfo) -> AccessibilityNodeInfo?,
    ): AccessibilityNodeInfo?

    fun screenDimensions(displayId: Int): ScreenDimensions?

    /** A [View] tied to the service context, used to invoke a ClickableSpan. */
    fun createView(): View

    /** Settle and publish a fresh hierarchy before acknowledging a successful node action. */
    suspend fun publishSettledHierarchy()

    fun forgetRememberedInsert()

    suspend fun sendActionResult(outcome: NodeActionResult)
  }

  /** Settle and publish a fresh hierarchy before acknowledging a successful node action. */
  suspend fun refreshHierarchyAfterNodeAction() = host.publishSettledHierarchy()

  companion object {
    private const val TAG = "CtrlProxy"
  }

  fun performAccessibilityLinkActivation(
    requestId: String?,
    text: String,
    occurrence: Int,
    selector: NodeSelector?,
  ) {
    val startTime = timeProvider.currentTimeMillis()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      host.launchRequestScope(requestId) {
        host.sendActionResult(
          NodeActionResult(
            requestId = requestId,
            action = "activate_accessibility_link",
            success = false,
            error = "Semantic accessibility links require Android API 26 or later",
            totalTimeMs = timeProvider.currentTimeMillis() - startTime,
          ),
        )
      }
      return
    }
    if (text.isBlank() || occurrence < 0) {
      host.launchRequestScope(requestId) {
        host.sendActionResult(
          NodeActionResult(
            requestId = requestId,
            action = "activate_accessibility_link",
            success = false,
            error = "Link text must be non-blank and occurrence must be non-negative",
            totalTimeMs = timeProvider.currentTimeMillis() - startTime,
          ),
        )
      }
      return
    }

    try {
      val root = host.activeWindowRoot()
      val owner = selector?.let { sel ->
        host.findNodeInDisplayWindows { findNodeBySelector(it, sel) }
      }
      if (selector != null && owner == null) {
        throw IllegalStateException("Selected link owner is no longer present")
      }
      val activation = SemanticLinkActivation(text, occurrence)
      activation.visit(owner ?: root)
      owner?.recycle()

      val error =
        when {
          activation.activated -> null
          activation.error != null -> "Semantic link activation failed: ${activation.error}"
          else -> "No actionable semantic link matching '$text' at occurrence $occurrence"
        }
      host.launchRequestScope(requestId) {
        host.sendActionResult(
          NodeActionResult(
            requestId = requestId,
            action = "activate_accessibility_link",
            success = activation.activated,
            error = error,
            totalTimeMs = timeProvider.currentTimeMillis() - startTime,
          ),
        )
      }
    } catch (error: IllegalArgumentException) {
      Log.w(TAG, "Semantic accessibility link activation failed", error)
      host.launchRequestScope(requestId) {
        host.sendActionResult(
          NodeActionResult(
            requestId = requestId,
            action = "activate_accessibility_link",
            success = false,
            error = error.message ?: error.javaClass.simpleName,
            totalTimeMs = timeProvider.currentTimeMillis() - startTime,
          ),
        )
      }
    } catch (error: IllegalStateException) {
      if (error is kotlinx.coroutines.CancellationException) throw error
      Log.w(TAG, "Semantic accessibility link activation failed", error)
      host.launchRequestScope(requestId) {
        host.sendActionResult(
          NodeActionResult(
            requestId = requestId,
            action = "activate_accessibility_link",
            success = false,
            error = error.message ?: error.javaClass.simpleName,
            totalTimeMs = timeProvider.currentTimeMillis() - startTime,
          ),
        )
      }
    } catch (error: SecurityException) {
      Log.w(TAG, "Semantic accessibility link activation failed", error)
      host.launchRequestScope(requestId) {
        host.sendActionResult(
          NodeActionResult(
            requestId = requestId,
            action = "activate_accessibility_link",
            success = false,
            error = error.message ?: error.javaClass.simpleName,
            totalTimeMs = timeProvider.currentTimeMillis() - startTime,
          ),
        )
      }
    }
  }

  private fun activateSemanticSpan(span: ClickableSpan): String? =
    try {
      // Accessibility exposes ClickableSpan only from API 26. Invoke its public
      // contract; no coordinate, reflection, or whole-node fallback is permitted.
      span.onClick(host.createView())
      null
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w(TAG, "Semantic accessibility span activation failed", error)
      error.message ?: error.javaClass.simpleName
    }

  private inner class SemanticLinkActivation(
    private val text: String,
    private val occurrence: Int,
  ) {
    private var matched = 0
    var activated = false
      private set

    var error: String? = null
      private set

    fun visit(node: AccessibilityNodeInfo?) {
      if (node == null || activated) return
      (node.text as? Spanned)?.let { activateSpans(it) }
      for (index in 0 until node.childCount) {
        val child = node.getChild(index) ?: continue
        try {
          visit(child)
        } finally {
          child.recycle()
        }
      }
    }

    private fun activateSpans(nodeText: Spanned) {
      nodeText
        .getSpans(0, nodeText.length, ClickableSpan::class.java)
        .sortedBy { nodeText.getSpanStart(it) }
        .forEach { span ->
          if (activated) return@forEach
          val start = nodeText.getSpanStart(span)
          val end = nodeText.getSpanEnd(span)
          val spanText = nodeText.subSequence(start, end).toString()
          if (spanText.equals(text, ignoreCase = true) && matched++ == occurrence) {
            error = activateSemanticSpan(span)
            activated = error == null
          }
        }
    }
  }

  /**
   * Perform an accessibility action on a node selected from observed stable fields. Resource ID is
   * preserved as the legacy selector; newer clients can additionally use test tags, Android unique
   * IDs, and collection coordinates.
   */
  suspend fun performNodeAction(
    requestId: String?,
    action: String,
    resourceId: String?,
    selector: NodeSelector?,
  ) {
    host.forgetRememberedInsert()
    val startTime = timeProvider.currentTimeMillis()
    val effectiveSelector = selector?.takeIf { it.hasCriteria() }
    val targetDescription = effectiveSelector?.toString() ?: "resource-id: $resourceId"
    Log.d(TAG, "performAction: action='$action', target='$targetDescription'")
    perfProvider.serial("performAction")

    try {
      if (effectiveSelector == null && resourceId.isNullOrEmpty()) {
        perfProvider.end()
        val errorTime = timeProvider.currentTimeMillis()
        val error = "A resource-id or stable node selector is required for accessibility actions"
        Log.w(TAG, error)
        host.launchRequestScope(requestId) {
          host.sendActionResult(
            NodeActionResult(
              requestId = requestId,
              action = action,
              success = false,
              error = error,
              totalTimeMs = errorTime - startTime,
            ),
          )
        }
        return
      }

      perfProvider.startOperation("findNode")
      val targetNode = host.findNodeInDisplayWindows { root ->
        if (effectiveSelector != null) {
          findNodeBySelector(root, effectiveSelector)
        } else if (resourceId != null) {
          findNodeByResourceIdOnRootDisplay(root, resourceId, host::screenDimensions)
        } else {
          null
        }
      }
      perfProvider.endOperation("findNode")

      if (targetNode == null) {
        perfProvider.end()
        val errorTime = timeProvider.currentTimeMillis()
        val error = "Element not found with $targetDescription"
        Log.w(TAG, error)
        host.launchRequestScope(requestId) {
          host.sendActionResult(
            NodeActionResult(
              requestId = requestId,
              action = action,
              success = false,
              error = error,
              totalTimeMs = errorTime - startTime,
            ),
          )
        }
        return
      }

      perfProvider.startOperation("executeAction")
      val decision =
        decideNodeAction(
          action,
          targetNode.isAccessibilityFocused,
          targetNode.actionList?.map { it.id },
        )
      val alreadySatisfied = decision is NodeActionDecision.AlreadySatisfied
      val actionError = (decision as? NodeActionDecision.Refused)?.message
      val success =
        alreadySatisfied ||
          (decision is NodeActionDecision.Perform && targetNode.performAction(decision.actionId))
      perfProvider.endOperation("executeAction")

      targetNode.recycle()
      perfProvider.end()

      Log.d(TAG, "Action completed: success=$success")

      // Wait for UI to settle after click/long_click/scroll, then extract fresh hierarchy
      if (success && action in listOf("click", "long_click", "scroll_forward", "scroll_backward")) {
        refreshHierarchyAfterNodeAction()
      }

      val totalTime = timeProvider.currentTimeMillis() - startTime
      Log.d(TAG, "Action total time: ${totalTime}ms")

      host.sendActionResult(
        NodeActionResult(
          requestId = requestId,
          action = action,
          success = success,
          error = if (success) null else actionError ?: "performAction returned false",
          totalTimeMs = totalTime,
          alreadySatisfied = alreadySatisfied,
        ),
      )
    } catch (e: CancellationException) {
      throw e
    } catch (e: IllegalArgumentException) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing action", e)
      host.sendActionResult(
        NodeActionResult(
          requestId = requestId,
          action = action,
          success = false,
          error = e.message,
          totalTimeMs = errorTime - startTime,
        ),
      )
    } catch (e: IllegalStateException) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing action", e)
      host.sendActionResult(
        NodeActionResult(
          requestId = requestId,
          action = action,
          success = false,
          error = e.message,
          totalTimeMs = errorTime - startTime,
        ),
      )
    } catch (e: SecurityException) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing action", e)
      host.sendActionResult(
        NodeActionResult(
          requestId = requestId,
          action = action,
          success = false,
          error = e.message,
          totalTimeMs = errorTime - startTime,
        ),
      )
    }
  }
}
