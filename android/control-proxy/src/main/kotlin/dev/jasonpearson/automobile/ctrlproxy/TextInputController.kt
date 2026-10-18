package dev.jasonpearson.automobile.ctrlproxy

import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.perf.MutablePerfEntry
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.sdk.logging.AutoMobileLog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put

/**
 * Accessibility-driven text input: set text, insert text at the caret, IME actions and select all,
 * plus the remembered-caret state that lets consecutive inserts into a Compose field continue where
 * the previous insert left off. Everything that needs the live accessibility service or the
 * late-bound WebSocket server comes through [Host] and [ResponseSender].
 *
 * The IME commitText path (rich-text autoformat, chunking, cancellation) stays in [CtrlProxy]; it
 * only reaches this controller to [forgetRememberedInsert].
 */
internal class TextInputController(
  private val host: Host,
  private val serviceScope: CoroutineScope,
  private val perfProvider: PerfProvider,
  private val timeProvider: TimeProvider,
  private val resultBroadcaster: ResultBroadcaster,
  private val jsonCompact: Json,
  private val responseSender: ResponseSender,
  private val uptimeMillis: () -> Long = android.os.SystemClock::uptimeMillis,
  private val pause: suspend (Long) -> Unit = { ms -> delay(ms) },
  private val sdkInt: Int = Build.VERSION.SDK_INT,
) {
  /** Service-side operations the controller cannot perform without the accessibility service. */
  interface Host {
    fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit)

    /** The service's `rootInActiveWindow`; callers own (and recycle) the returned node. */
    fun activeWindowRoot(): AccessibilityNodeInfo?

    fun screenDimensions(displayId: Int): ScreenDimensions?

    /** Sets the soft keyboard show mode to `SHOW_MODE_HIDDEN`. May throw. */
    fun hideSoftKeyboard()

    /**
     * Sends an editor navigation action through the CtrlProxy IME. Null when the IME has no live
     * input connection, so the caller falls back to focus traversal.
     */
    suspend fun performImeNavigationAction(actionId: Int): Boolean?

    /** Pre-API 30 fallback for IME enter: injects KEYCODE_ENTER. May throw. */
    fun sendKeycodeEnter(): Boolean

    /** Waits for hierarchy quiescence, then broadcasts the fresh hierarchy if one was extracted. */
    suspend fun publishSettledHierarchy()
  }

  /** Keeps the service's frame encoder and late-bound WebSocket server behind one seam. */
  interface ResponseSender {
    fun isRunning(): Boolean

    suspend fun broadcastWithPerf(
      type: String,
      requestId: String?,
      buildContent: JsonObjectBuilder.() -> Unit,
    )

    suspend fun broadcastWithPerfSync(
      type: String,
      requestId: String?,
      buildContent: JsonObjectBuilder.() -> Unit,
    )

    fun connectionCount(): Int
  }

  companion object {
    private const val TAG = "CtrlProxy"
    private const val REMEMBER_TTL_MS = 5_000L
  }

  /**
   * Drops the remembered insert caret; any command or UI change that may move the caret calls it.
   */
  fun forgetRememberedInsert() {
    rememberedInsert = null
  }

  /** A selection change that does not match the remembered caret invalidates it. */
  fun onTextSelectionChanged(fromIndex: Int, toIndex: Int) {
    val caret = rememberedInsert?.second?.caret
    if (caret != null && (fromIndex != caret.reportedStart || toIndex != caret.reportedEnd)) {
      rememberedInsert = null
    }
  }

  fun handleInsertTextState(requestId: String?) {
    // The host awaits this reply BEFORE dispatching ADB key events. No baseline is stored globally.
    host.launchRequestScope(requestId) {
      if (!responseSender.isRunning()) {
        Log.d(TAG, "WebSocket server not running, skipping insert text state result broadcast")
        return@launchRequestScope
      }
      val node = findFocusedEditableNode(host.activeWindowRoot())
      val state =
        try {
          if (
            node != null && node.refresh() && node.isEditable && node.isFocused && !node.isPassword
          ) {
            InsertTextSnapshot(
              node.text?.toString(),
              node.isShowingHintTextCompat(),
              node.textSelectionStart,
              node.textSelectionEnd,
            )
          } else null
        } finally {
          node?.recycle()
        }
      resultBroadcaster.guard(requestId, "insert_text_state_result") {
        responseSender.broadcastWithPerfSync("insert_text_state_result", requestId) {
          put("success", true)
          if (state != null) put("state", jsonCompact.encodeToJsonElement(state))
        }
      }
    }
  }

  /**
   * Perform text input using AccessibilityService's ACTION_SET_TEXT. This is significantly faster
   * than ADB's input text command.
   */
  suspend fun performSetText(
    requestId: String?,
    text: String,
    resourceId: String?,
    dismissKeyboard: Boolean = false,
  ) {
    rememberedInsert = null
    val startTime = timeProvider.currentTimeMillis()
    // Never log the text: the target may be a password field.
    Log.d(TAG, "performSetText: ${text.length} chars resourceId=$resourceId")
    perfProvider.serial("performSetText")

    try {
      perfProvider.startOperation("findNode")
      val root = host.activeWindowRoot()
      var foundTargetNode: android.view.accessibility.AccessibilityNodeInfo? = null
      try {
        foundTargetNode =
          if (resourceId != null) {
            // Find node by resource-id
            findNodeByResourceIdOnRootDisplay(root, resourceId, host::screenDimensions)
          } else {
            // Find currently focused input node
            findFocusedEditableNode(root)
          }
      } finally {
        if (root !== foundTargetNode) {
          root?.recycle()
        }
      }
      val targetNode = foundTargetNode
      perfProvider.endOperation("findNode")

      if (targetNode == null) {
        perfProvider.end()
        val errorTime = timeProvider.currentTimeMillis()
        val error =
          if (resourceId != null) {
            "No node found with resource-id: $resourceId"
          } else {
            "No focused editable node found"
          }
        Log.w(TAG, error)
        host.launchRequestScope(requestId) {
          broadcastSetTextResult(requestId, false, error, errorTime - startTime)
        }
        return
      }

      perfProvider.startOperation("setText")
      val arguments =
        android.os.Bundle().apply {
          putCharSequence(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
            text,
          )
        }
      val success =
        try {
          targetNode.performAction(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT,
            arguments,
          )
        } finally {
          targetNode.recycle()
        }
      perfProvider.endOperation("setText")
      perfProvider.end()

      Log.d(TAG, "Set text completed: success=$success")

      // Dismiss the soft keyboard if requested.
      // When enabled (via --dismiss-keyboard-after-input or per-call dismissKeyboard param),
      // SHOW_MODE_HIDDEN suppresses the keyboard globally for the accessibility service.
      // This prevents the keyboard from stealing touch events and accessibility focus
      // from UI elements behind it during subsequent tapOn steps.
      if (success && dismissKeyboard) {
        try {
          host.hideSoftKeyboard()
          Log.d(TAG, "[KeyboardDismiss] Set SHOW_MODE_HIDDEN after text injection")
        } catch (e: CancellationException) {
          throw e
        } catch (e: Exception) {
          Log.w(TAG, "[KeyboardDismiss] softKeyboardController failed", e)
        }
      }

      val totalTime = timeProvider.currentTimeMillis() - startTime
      Log.d(TAG, "Set text completed in ${totalTime}ms")
      // ACTION_SET_TEXT and the requested keyboard state are complete, so acknowledge before
      // optional hierarchy work. Waiting for quiescence/extraction first can turn a completed
      // write into a host-side timeout.
      broadcastSetTextResult(
        requestId,
        success,
        if (success) null else "performAction returned false",
        totalTime,
      )

      if (success) refreshHierarchyAfterTextInput()
    } catch (e: CancellationException) {
      perfProvider.end()
      throw e
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing set text", e)
      broadcastSetTextResult(requestId, false, e.message, errorTime - startTime)
    }
  }

  /**
   * Publishes the settled text state after a successful text mutation without delaying its result.
   */
  private fun refreshHierarchyAfterTextInput() {
    serviceScope.launch {
      try {
        host.publishSettledHierarchy()
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        Log.w(TAG, "Failed to refresh hierarchy after text input", e)
      }
    }
  }

  private data class InsertNodeKey(
    val windowId: Int,
    val packageName: String?,
    val className: String?,
    val viewId: String?,
  )

  private data class RememberedCaretAt(val caret: RememberedCaret, val atMs: Long)

  // Compose may expose no stable view ID. Exact text AND reported selection, command/event
  // invalidation, and a 5s TTL bound reuse to a continuation of the previous insert.
  @Volatile private var rememberedInsert: Pair<InsertNodeKey, RememberedCaretAt>? = null

  /**
   * Insert text at the focused field's current selection using accessibility actions.
   *
   * Android exposes replacement through ACTION_SET_TEXT but no separate insert primitive. Build the
   * new value from the node's UTF-16 selection range, then restore the caret immediately after the
   * inserted text. This matches ordinary typing: a collapsed selection inserts at the caret, while
   * a non-empty selection is replaced. If the selection is invalid, refresh the node once and
   * append at the end of its current text if the refreshed selection is still invalid.
   */
  suspend fun performInsertText(
    requestId: String?,
    text: String,
    expectedSuffix: String?,
    acceptsCaretNotPlaced: Boolean,
    precedingState: InsertTextSnapshot? = null,
  ) {
    val startTime = timeProvider.currentTimeMillis()
    // Suspend waits can resume on another IO thread; keep timing out of a thread-local stack.
    val insertPerf = MutablePerfEntry("performInsertText", startTime)
    fun finishPerf() {
      if (insertPerf.endTime == null) {
        insertPerf.endTime = timeProvider.currentTimeMillis()
        perfProvider.complete(insertPerf)
      }
    }

    var nodeToRecycle: android.view.accessibility.AccessibilityNodeInfo? = null
    val warnings = mutableListOf<String>()
    var textMutated = false
    try {
      val originalNode = findFocusedEditableNode(host.activeWindowRoot())
      if (originalNode == null) {
        rememberedInsert = null
        finishPerf()
        host.launchRequestScope(requestId) {
          broadcastInsertTextResult(
            requestId,
            false,
            "No focused editable node found",
            timeProvider.currentTimeMillis() - startTime,
          )
        }
        return
      }

      var targetNode: android.view.accessibility.AccessibilityNodeInfo = originalNode
      nodeToRecycle = targetNode
      if (targetNode.isPassword) {
        rememberedInsert = null
        targetNode.recycle()
        nodeToRecycle = null
        finishPerf()
        broadcastInsertTextResult(
          requestId,
          false,
          "Cannot insert text into a password field without exposing its original value",
          timeProvider.currentTimeMillis() - startTime,
        )
        return
      }

      fun nodeKey() =
        InsertNodeKey(
          targetNode.windowId,
          targetNode.packageName?.toString(),
          targetNode.className?.toString(),
          targetNode.viewIdResourceName,
        )

      fun readFreshSnapshot(): InsertTextSnapshot? {
        if (nodeToRecycle == null) return null
        if (!targetNode.refresh()) {
          val replacementNode = findFocusedEditableNode(host.activeWindowRoot())
          targetNode.recycle()
          nodeToRecycle = replacementNode
          if (replacementNode == null) {
            rememberedInsert = null
            return null
          }
          targetNode = replacementNode
        }
        // Re-found nodes may be password/non-editable fields. Never read their text or mutate them.
        if (!targetNode.isEditable || !targetNode.isFocused || targetNode.isPassword) {
          rememberedInsert = null
          return null
        }
        if (rememberedInsert?.first != nodeKey()) rememberedInsert = null
        return InsertTextSnapshot(
          targetNode.text?.toString(),
          targetNode.isShowingHintTextCompat(),
          targetNode.textSelectionStart,
          targetNode.textSelectionEnd,
        )
      }

      // Every insert, including a caret-warning remainder, plans against a refreshed node.
      var snapshot = readFreshSnapshot()
      val waitStarted = uptimeMillis()
      val remembered = rememberedInsert?.takeIf {
        it.first == nodeKey() && uptimeMillis() - it.second.atMs <= REMEMBER_TTL_MS
      }
      if (remembered == null) rememberedInsert = null
      val rememberedTextMatched = remembered?.let {
        snapshot?.let { s -> !s.isShowingHintText && s.text.orEmpty() == it.second.caret.text }
      }
      if (remembered != null && snapshot != null && rememberedTextMatched == false) {
        val matched =
          awaitPrecedingInput(
            expectedSuffix = "",
            readSnapshot = { readFreshSnapshot().also { snapshot = it } },
            nowMs = { uptimeMillis() },
            pause = pause,
            matches = { s ->
              nodeKey() == remembered.first &&
                !s.isShowingHintText &&
                s.text.orEmpty() == remembered.second.caret.text
            },
          )
        if (!matched) {
          rememberedInsert = null
          warnings.add(
            "The field changed since the previous insert; its text did not match within 300ms, so the reported selection was used",
          )
        }
      }
      if (snapshot != null && shouldWaitForPrecedingInput(expectedSuffix)) {
        val observed =
          awaitPrecedingInput(
            expectedSuffix = requireNotNull(expectedSuffix),
            baseline = precedingState,
            readSnapshot = { readFreshSnapshot().also { snapshot = it } },
            nowMs = { uptimeMillis() },
            pause = pause,
          )
        if (!observed) {
          warnings.add(
            "Preceding key-event input was not observed in the field within 300ms; the inserted text was planned against the latest observed value, so earlier input may have been overwritten",
          )
        }
      }
      AutoMobileLog.d(
        TAG,
        "insertText rememberedTextMatchedInitially=${rememberedTextMatched == true} rememberedTextMatchedAfterWait=${remembered != null && snapshot?.text == remembered.second.caret.text && snapshot?.isShowingHintText == false} waitMs=${uptimeMillis() - waitStarted}",
      )
      val liveSnapshot = snapshot
      if (liveSnapshot == null) {
        val error =
          when {
            nodeToRecycle == null -> "No focused editable node found"
            targetNode.isPassword ->
              "Cannot insert text into a password field without exposing its original value"
            !targetNode.isEditable -> "Focused node is not editable"
            else -> "No focused editable node found"
          }
        nodeToRecycle?.recycle()
        nodeToRecycle = null
        rememberedInsert = null
        finishPerf()
        broadcastInsertTextResult(
          requestId,
          false,
          error,
          timeProvider.currentTimeMillis() - startTime,
          warning = warnings.takeIf { it.isNotEmpty() }?.joinToString(" "),
        )
        return
      }
      // Reuse only when no command/event invalidated the same entry during polling.
      val caret =
        rememberedInsert
          ?.takeIf {
            it == remembered && uptimeMillis() - it.second.atMs <= REMEMBER_TTL_MS
          }
          ?.second
          ?.caret
      val plan =
        planInsertText(
          liveSnapshot.text,
          liveSnapshot.isShowingHintText,
          liveSnapshot.selectionStart,
          liveSnapshot.selectionEnd,
          text,
          caret,
        )
      if (!plan.usedRememberedCaret) rememberedInsert = null
      val precedingWarning = warnings.takeIf { it.isNotEmpty() }?.joinToString(" ")
      AutoMobileLog.d(
        TAG,
        "insertText selectionBeforeStart=${liveSnapshot.selectionStart} selectionBeforeEnd=${liveSnapshot.selectionEnd} textLength=${liveSnapshot.text.orEmpty().length}",
      )

      val actionIds = targetNode.actionList.map { it.id }.toSet()
      AutoMobileLog.d(
        TAG,
        "insertText selectionActionListed=${android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION in actionIds}",
      )
      val requiredActions =
        if (plan.usedFallbackCaret || plan.usedRememberedCaret) {
          mapOf(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT to "ACTION_SET_TEXT",
          )
        } else {
          mapOf(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT to "ACTION_SET_TEXT",
            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION to
              "ACTION_SET_SELECTION",
          )
        }
      val unsupportedAction = requiredActions.entries.firstOrNull { it.key !in actionIds }
      if (unsupportedAction != null) {
        targetNode.recycle()
        nodeToRecycle = null
        finishPerf()
        broadcastInsertTextResult(
          requestId,
          false,
          "Focused editable node does not support ${unsupportedAction.value}",
          timeProvider.currentTimeMillis() - startTime,
          warning = precedingWarning,
        )
        return
      }

      val setTextArguments =
        android.os.Bundle().apply {
          putCharSequence(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
            plan.updatedText,
          )
        }
      val setTextSucceeded =
        targetNode.performAction(
          android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT,
          setTextArguments,
        )
      textMutated = setTextSucceeded
      // Compose may acknowledge SET_TEXT before its semantics reflect the replacement. Wait
      // briefly on the same node before reading selection support and placing the caret (#10414).
      val mutationNodeKey = nodeKey()
      fun readMutationSnapshot(): InsertTextSnapshot? {
        // After writing, never re-find and move a caret in a different focused field.
        if (
          !targetNode.refresh() ||
            nodeKey() != mutationNodeKey ||
            !targetNode.isEditable ||
            !targetNode.isFocused ||
            targetNode.isPassword
        )
          return null
        return InsertTextSnapshot(
          targetNode.text?.toString(),
          targetNode.isShowingHintTextCompat(),
          targetNode.textSelectionStart,
          targetNode.textSelectionEnd,
        )
      }
      val afterSetText =
        if (setTextSucceeded) {
          awaitInsertTextMutation(
            plan,
            readSnapshot = ::readMutationSnapshot,
            nowMs = { uptimeMillis() },
            pause = pause,
          )
        } else null
      AutoMobileLog.d(
        TAG,
        "insertText selectionAfterSetTextStart=${afterSetText?.selectionStart ?: -1} selectionAfterSetTextEnd=${afterSetText?.selectionEnd ?: -1}",
      )
      val selectionAttempted =
        setTextSucceeded &&
          afterSetText != null &&
          android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION in
            targetNode.actionList.map { it.id }
      val selectionReturned =
        if (selectionAttempted) {
          val selectionArguments =
            android.os.Bundle().apply {
              putInt(
                android.view.accessibility.AccessibilityNodeInfo
                  .ACTION_ARGUMENT_SELECTION_START_INT,
                plan.caret,
              )
              putInt(
                android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT,
                plan.caret,
              )
            }
          targetNode.performAction(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION,
            selectionArguments,
          )
        } else false
      // A widget may reject SET_SELECTION when SET_TEXT already placed the caret correctly.
      val observedSelection =
        if (selectionAttempted && !selectionReturned) readMutationSnapshot() else afterSetText
      val selectionSucceeded =
        insertTextSelectionSucceeded(
          setTextSucceeded,
          selectionAttempted,
          selectionReturned,
          plan,
          observedSelection,
        )
      AutoMobileLog.d(
        TAG,
        "insertText selectionAttempted=$selectionAttempted selectionReturned=$selectionReturned",
      )
      // Record the reported selection after placement, including the rejected-action refresh.
      val afterSelection =
        if (afterSetText != null)
          InsertTextSnapshot(
            targetNode.text?.toString(),
            targetNode.isShowingHintTextCompat(),
            targetNode.textSelectionStart,
            targetNode.textSelectionEnd,
          )
        else null
      val outcome =
        insertTextOutcome(
          setTextSucceeded,
          selectionAttempted,
          selectionSucceeded,
          precedingWarning,
          acceptsCaretNotPlaced,
        )
      rememberedInsert = afterSelection?.let { s ->
        nextRememberedCaret(outcome, plan, s.selectionStart, s.selectionEnd)?.let {
          nodeKey() to RememberedCaretAt(it, uptimeMillis())
        }
      }
      nodeToRecycle?.recycle()
      nodeToRecycle = null
      finishPerf()

      broadcastInsertTextResult(
        requestId,
        outcome.success,
        outcome.error,
        timeProvider.currentTimeMillis() - startTime,
        outcome.partialApplication,
        outcome.warning,
        outcome.caretPlaced,
        if (setTextSucceeded && acceptsCaretNotPlaced) plan.updatedText.length else null,
      )
      if (setTextSucceeded) refreshHierarchyAfterTextInput()
    } catch (e: CancellationException) {
      rememberedInsert = null
      nodeToRecycle?.recycle()
      finishPerf()
      throw e
    } catch (e: Exception) {
      rememberedInsert = null
      nodeToRecycle?.recycle()
      finishPerf()
      Log.e(TAG, "Error inserting text", e)
      broadcastInsertTextResult(
        requestId,
        false,
        e.message,
        timeProvider.currentTimeMillis() - startTime,
        partialApplication = textMutated,
        warning = warnings.takeIf { it.isNotEmpty() }?.joinToString(" "),
      )
    }
  }

  internal enum class ImeActionStep(val error: String? = null, val approximated: Boolean? = null) {
    NO_FOCUSED_EDITABLE("No focused editable node found for IME action"),
    NEXT(approximated = true),
    PREVIOUS(approximated = true),
    EDITOR_NEXT,
    EDITOR_PREVIOUS,
    IME_ENTER,
    KEYCODE_ENTER,
    UNSUPPORTED;

    companion object {
      fun select(
        action: String,
        hasFocusedEditable: Boolean,
        sdkInt: Int,
        hasImeConnection: Boolean = false,
      ): ImeActionStep {
        if (hasImeConnection) {
          if (action == "next") return EDITOR_NEXT
          if (action == "previous") return EDITOR_PREVIOUS
        }
        if (!hasFocusedEditable) {
          return NO_FOCUSED_EDITABLE
        }
        return when (action) {
          "next" -> NEXT
          "previous" -> PREVIOUS
          "done",
          "go",
          "send",
          "search" -> if (sdkInt >= android.os.Build.VERSION_CODES.R) IME_ENTER else KEYCODE_ENTER
          else -> UNSUPPORTED
        }
      }
    }
  }

  /**
   * Dispatch navigation through the active IME when possible, otherwise approximate it with focus
   * traversal. Other keyboard actions retain their AccessibilityService handling.
   */
  suspend fun performImeAction(requestId: String?, action: String) {
    rememberedInsert = null
    val startTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "performImeAction: action='$action'")
    // Suspend waits can resume on another IO thread; keep timing out of a thread-local stack.
    val imePerf = MutablePerfEntry("performImeAction", startTime)
    fun finishPerf() {
      if (imePerf.endTime == null) {
        imePerf.endTime = timeProvider.currentTimeMillis()
        perfProvider.complete(imePerf)
      }
    }

    var root: android.view.accessibility.AccessibilityNodeInfo? = null
    var focusedNode: android.view.accessibility.AccessibilityNodeInfo? = null
    var approximated: Boolean? = null
    try {
      val findFocusedNodePerf =
        MutablePerfEntry("findFocusedNode", timeProvider.currentTimeMillis())
      imePerf.children.add(findFocusedNodePerf)
      root = host.activeWindowRoot()
      focusedNode = findFocusedEditableNode(root)
      findFocusedNodePerf.endTime = timeProvider.currentTimeMillis()

      val navigationActionId =
        when (action) {
          "next" -> android.view.inputmethod.EditorInfo.IME_ACTION_NEXT
          "previous" -> android.view.inputmethod.EditorInfo.IME_ACTION_PREVIOUS
          else -> null
        }
      val editorActionResult =
        if (navigationActionId != null) {
          host.performImeNavigationAction(navigationActionId)
        } else null
      // Accessibility nodes expose no configured imeOptions. ACTION_IME_ENTER alone does not
      // prove the editor is configured for NEXT, so an unavailable IME uses traversal.
      val step =
        ImeActionStep.select(
          action,
          focusedNode != null,
          sdkInt,
          hasImeConnection = editorActionResult != null,
        )
      approximated = step.approximated
      val error = step.error
      if (error != null) {
        finishPerf()
        val errorTime = timeProvider.currentTimeMillis()
        Log.w(TAG, error)
        host.launchRequestScope(requestId) {
          broadcastImeActionResult(requestId, action, false, error, errorTime - startTime)
        }
        return
      }

      val executeActionPerf = MutablePerfEntry("executeAction", timeProvider.currentTimeMillis())
      imePerf.children.add(executeActionPerf)
      val success =
        when (step) {
          ImeActionStep.EDITOR_NEXT,
          ImeActionStep.EDITOR_PREVIOUS -> editorActionResult == true
          ImeActionStep.NEXT -> {
            // Find next focusable element and focus it
            val nextNode = findNextFocusableNode(root, focusedNode!!)
            if (nextNode != null) {
              val focusSuccess =
                nextNode.performAction(
                  android.view.accessibility.AccessibilityNodeInfo.ACTION_FOCUS,
                )
              nextNode.recycle()
              focusSuccess
            } else {
              Log.w(TAG, "No next focusable node found")
              false
            }
          }
          ImeActionStep.PREVIOUS -> {
            // Find previous focusable element and focus it
            val prevNode = findPreviousFocusableNode(root, focusedNode!!)
            if (prevNode != null) {
              val focusSuccess =
                prevNode.performAction(
                  android.view.accessibility.AccessibilityNodeInfo.ACTION_FOCUS,
                )
              prevNode.recycle()
              focusSuccess
            } else {
              Log.w(TAG, "No previous focusable node found")
              false
            }
          }
          ImeActionStep.IME_ENTER -> {
            // API 30+: Use ACTION_IME_ENTER for proper IME action handling
            @Suppress("NewApi")
            val actionId =
              android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER
                .id
            val imeResult = focusedNode!!.performAction(actionId)
            Log.d(TAG, "ACTION_IME_ENTER result: $imeResult")
            imeResult
          }
          ImeActionStep.KEYCODE_ENTER -> {
            // Pre-API 30: Fall back to pressing Enter key via input shell command
            // This is less reliable but works on older devices
            Log.d(TAG, "Pre-API 30: falling back to KEYCODE_ENTER")
            try {
              host.sendKeycodeEnter()
            } catch (e: CancellationException) {
              throw e
            } catch (e: Exception) {
              Log.e(TAG, "Failed to send KEYCODE_ENTER", e)
              false
            }
          }
          else -> {
            Log.w(TAG, "Unknown IME action: $action")
            false
          }
        }
      executeActionPerf.endTime = timeProvider.currentTimeMillis()

      finishPerf()

      Log.d(TAG, "IME action completed: success=$success")

      // Wait for UI to settle, then extract fresh hierarchy
      if (success) {
        host.publishSettledHierarchy()
      }

      val totalTime = timeProvider.currentTimeMillis() - startTime
      Log.d(TAG, "IME action total time: ${totalTime}ms")

      broadcastImeActionResult(
        requestId,
        action,
        success,
        if (success) null else "Action failed",
        totalTime,
        approximated,
      )
    } catch (e: CancellationException) {
      finishPerf()
      throw e
    } catch (e: Exception) {
      finishPerf()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing IME action", e)
      broadcastImeActionResult(
        requestId,
        action,
        false,
        e.message,
        errorTime - startTime,
        approximated,
      )
    } finally {
      if (focusedNode !== root) {
        focusedNode?.recycle()
      }
      root?.recycle()
    }
  }

  /**
   * Perform select all text using AccessibilityService's ACTION_SET_SELECTION. This is
   * significantly faster than using ADB double-tap gestures.
   */
  suspend fun performSelectAll(requestId: String?) {
    rememberedInsert = null
    val startTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "performSelectAll")
    perfProvider.serial("performSelectAll")

    try {
      perfProvider.startOperation("findFocusedNode")
      val focusedNode = findFocusedEditableNode(host.activeWindowRoot())
      perfProvider.endOperation("findFocusedNode")

      if (focusedNode == null) {
        perfProvider.end()
        val errorTime = timeProvider.currentTimeMillis()
        val error = "No focused editable node found"
        Log.w(TAG, error)
        broadcastSelectAllResult(requestId, false, error, errorTime - startTime)
        return
      }

      perfProvider.startOperation("setSelection")
      // Get the text length to set selection from 0 to end
      val text = focusedNode.text
      val plan =
        planSelectAll(
          text?.length ?: 0,
          focusedNode.isShowingHintTextCompat(),
          focusedNode.textSelectionStart,
          focusedNode.textSelectionEnd,
        )
      val textLength = plan.textLength

      val outcome =
        if (plan.shouldPerformAction) {
          // Use ACTION_SET_SELECTION with start=0 and end=textLength to select all
          val arguments =
            android.os.Bundle().apply {
              putInt(
                android.view.accessibility.AccessibilityNodeInfo
                  .ACTION_ARGUMENT_SELECTION_START_INT,
                0,
              )
              putInt(
                android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT,
                textLength,
              )
            }
          val actionSucceeded =
            focusedNode.performAction(
              android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION,
              arguments,
            )
          val selectionRefreshed = !actionSucceeded && focusedNode.refresh()
          selectAllOutcome(
            textLength,
            actionSucceeded,
            selectionRefreshed,
            if (selectionRefreshed) focusedNode.textSelectionStart else -1,
            if (selectionRefreshed) focusedNode.textSelectionEnd else -1,
          )
        } else {
          // No text to select, or all text is already selected
          if (textLength == 0) Log.d(TAG, "No text in focused node to select")
          SelectAllOutcome(true, null)
        }
      val success = outcome.success

      focusedNode.recycle()
      perfProvider.endOperation("setSelection")
      perfProvider.end()

      Log.d(TAG, "Select all completed: success=$success, textLength=$textLength")

      val totalTime = timeProvider.currentTimeMillis() - startTime
      Log.d(TAG, "Select all total time: ${totalTime}ms")

      broadcastSelectAllResult(
        requestId,
        success,
        outcome.error,
        totalTime,
      )
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing select all", e)
      broadcastSelectAllResult(requestId, false, e.message, errorTime - startTime)
    }
  }

  /** Broadcast set text result to WebSocket clients */
  suspend fun broadcastSetTextResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping set text result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "set_text_result") {
      responseSender.broadcastWithPerfSync("set_text_result", requestId) {
        put("success", success)
        put("totalTimeMs", totalTimeMs)
        if (error != null) {
          put("error", error)
        }
      }
      Log.d(TAG, "Broadcasted set text result to ${responseSender.connectionCount()} clients")
    }
  }

  /** Broadcast insert text result to WebSocket clients. */
  private suspend fun broadcastInsertTextResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    partialApplication: Boolean = false,
    warning: String? = null,
    caretPlaced: Boolean? = null,
    resultingTextLength: Int? = null,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping insert text result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "insert_text_result") {
      responseSender.broadcastWithPerfSync("insert_text_result", requestId) {
        InsertTextResultBody(
            success = success,
            totalTimeMs = totalTimeMs,
            error = error,
            warning = warning,
            caretPlaced = caretPlaced,
            resultingTextLength = resultingTextLength,
            partialApplication = partialApplication,
          )
          .putInto(this)
      }
    }
  }

  /** Broadcast IME action result to WebSocket clients */
  suspend fun broadcastImeActionResult(
    requestId: String?,
    action: String,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    approximated: Boolean? = null,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping IME action result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "ime_action_result") {
      responseSender.broadcastWithPerf("ime_action_result", requestId) {
        if (approximated != null) put("approximated", approximated)
        put("action", action)
        put("success", success)
        put("totalTimeMs", totalTimeMs)
        if (error != null) {
          put("error", error)
        }
      }
      Log.d(TAG, "Broadcasted IME action result to ${responseSender.connectionCount()} clients")
    }
  }

  /** Broadcast select all result to WebSocket clients */
  private suspend fun broadcastSelectAllResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping select all result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "select_all_result") {
      responseSender.broadcastWithPerf("select_all_result", requestId) {
        put("success", success)
        put("totalTimeMs", totalTimeMs)
        if (error != null) {
          put("error", error)
        }
      }
      Log.d(TAG, "Broadcasted select all result to ${responseSender.connectionCount()} clients")
    }
  }
}

/** `isShowingHintText` is API 26+; older platforms cannot report it, so treat the text as real. */
private fun AccessibilityNodeInfo.isShowingHintTextCompat(): Boolean =
  Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isShowingHintText
