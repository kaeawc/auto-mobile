package dev.jasonpearson.automobile.ctrlproxy

import android.os.Build
import android.os.Bundle
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
    val validationError = accessibilityLinkError(text, occurrence)
    if (validationError != null) {
      host.launchRequestScope(requestId) {
        host.sendActionResult(
          NodeActionResult(
            requestId = requestId,
            action = "activate_accessibility_link",
            success = false,
            error = validationError,
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
      reportLinkFailure(requestId, startTime, error)
    } catch (error: IllegalStateException) {
      if (error is kotlinx.coroutines.CancellationException) throw error
      reportLinkFailure(requestId, startTime, error)
    } catch (error: SecurityException) {
      reportLinkFailure(requestId, startTime, error)
    }
  }

  private fun reportLinkFailure(requestId: String?, startTime: Long, error: Exception) {
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

  private fun findActionNode(
    effectiveSelector: NodeSelector?,
    resourceId: String?,
  ): AccessibilityNodeInfo? {
    return host.findNodeInDisplayWindows { root ->
      if (effectiveSelector != null) {
        findNodeBySelector(root, effectiveSelector)
      } else if (resourceId != null) {
        findNodeByResourceIdOnRootDisplay(root, resourceId, host::screenDimensions)
      } else {
        null
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
    arguments: NodeActionArguments = NodeActionArguments(),
  ) {
    host.forgetRememberedInsert()
    val startTime = timeProvider.currentTimeMillis()
    val effectiveSelector = selector?.takeIf { it.hasCriteria() }
    val targetDescription = effectiveSelector?.toString() ?: "resource-id: $resourceId"
    Log.d(TAG, "performAction: action='$action', target='$targetDescription'")
    perfProvider.serial("performAction")

    NodeActionOperation(requestId, action, startTime, arguments)
      .run(
        NodeActionTarget(effectiveSelector, resourceId, targetDescription),
      )
  }

  private inner class NodeActionOperation(
    private val requestId: String?,
    private val action: String,
    private val startTime: Long,
    private val arguments: NodeActionArguments,
  ) {
    suspend fun run(target: NodeActionTarget) {
      try {
        perform(target)
      } catch (e: CancellationException) {
        throw e
      } catch (e: IllegalArgumentException) {
        reportFailure(e)
      } catch (e: IllegalStateException) {
        reportFailure(e)
      } catch (e: SecurityException) {
        reportFailure(e)
      }
    }

    private suspend fun perform(target: NodeActionTarget) {
      if (target.selector == null && target.resourceId.isNullOrEmpty()) {
        perfProvider.end()
        val errorTime = timeProvider.currentTimeMillis()
        val error = "A resource-id or stable node selector is required for accessibility actions"
        reportMissing(error, errorTime)
        return
      }

      perfProvider.startOperation("findNode")
      val targetNode = findActionNode(target.selector, target.resourceId)
      perfProvider.endOperation("findNode")

      if (targetNode == null) {
        perfProvider.end()
        val errorTime = timeProvider.currentTimeMillis()
        val error = "Element not found with ${target.description}"
        reportMissing(error, errorTime)
        return
      }

      perfProvider.startOperation("executeAction")
      val (alreadySatisfied, actionError, success) =
        executeNodeAction(action, targetNode, arguments)
      perfProvider.endOperation("executeAction")

      targetNode.recycle()
      perfProvider.end()

      Log.d(TAG, "Action completed: success=$success")

      // Wait for UI to settle after any visible action, then extract fresh hierarchy
      if (success && action !in NON_VISUAL_NODE_ACTIONS) {
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
    }

    private suspend fun reportFailure(e: Exception) {
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

    private fun reportMissing(error: String, errorTime: Long) {
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
    }
  }
}

private data class NodeActionOutcome(
  val alreadySatisfied: Boolean,
  val error: String?,
  val success: Boolean,
)

private fun executeNodeAction(
  action: String,
  targetNode: AccessibilityNodeInfo,
  arguments: NodeActionArguments,
): NodeActionOutcome {
  val actions = targetNode.actionList
  val decision =
    decideNodeAction(
      action,
      NodeActionState(
        targetNode.isAccessibilityFocused,
        actions?.map { it.id },
        actions?.mapNotNull { entry -> entry.label?.toString()?.let { entry.id to it } }?.toMap()
          ?: emptyMap(),
      ),
      Build.VERSION.SDK_INT,
      arguments,
    )
  val alreadySatisfied = decision is NodeActionDecision.AlreadySatisfied
  val actionError = (decision as? NodeActionDecision.Refused)?.message
  val success =
    alreadySatisfied ||
      (decision is NodeActionDecision.Perform && performNodeDecision(targetNode, decision))
  return NodeActionOutcome(alreadySatisfied, actionError, success)
}

private fun performNodeDecision(
  targetNode: AccessibilityNodeInfo,
  decision: NodeActionDecision.Perform,
): Boolean {
  val progress = decision.progress ?: return targetNode.performAction(decision.actionId)
  val arguments =
    Bundle().apply { putFloat(AccessibilityNodeInfo.ACTION_ARGUMENT_PROGRESS_VALUE, progress) }
  return targetNode.performAction(decision.actionId, arguments)
}

private fun accessibilityLinkError(text: String, occurrence: Int): String? =
  when {
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O ->
      "Semantic accessibility links require Android API 26 or later"
    text.isBlank() || occurrence < 0 ->
      "Link text must be non-blank and occurrence must be non-negative"
    else -> null
  }

private data class NodeActionTarget(
  val selector: NodeSelector?,
  val resourceId: String?,
  val description: String,
)
