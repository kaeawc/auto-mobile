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

/** Encoding and delivery for text-input result frames. */
internal data class TextInputResponseDependencies(
  val jsonCompact: Json,
  val resultSender: ResultSender,
)

/** Platform version and timing seams for text-input fallbacks and caret retention. */
internal data class TextInputConfig(
  val uptimeMillis: () -> Long = android.os.SystemClock::uptimeMillis,
  val pause: suspend (Long) -> Unit = { ms -> delay(ms) },
  val sdkInt: Int = Build.VERSION.SDK_INT,
)

/**
 * Accessibility-driven text input: set text, insert text at the caret, IME actions and select all,
 * plus the remembered-caret state that lets consecutive inserts into a Compose field continue where
 * the previous insert left off. Everything that needs the live accessibility service or the
 * late-bound WebSocket server comes through [Host] and [ResultSender].
 *
 * The IME commitText path (rich-text autoformat, chunking, cancellation) stays in [CtrlProxy]; it
 * only reaches this controller to [forgetRememberedInsert].
 */
internal class TextInputController(
  private val host: Host,
  private val serviceScope: CoroutineScope,
  private val perfProvider: PerfProvider,
  private val timeProvider: TimeProvider,
  responses: TextInputResponseDependencies,
  config: TextInputConfig = TextInputConfig(),
) {
  private val jsonCompact = responses.jsonCompact
  private val resultSender = responses.resultSender
  private val uptimeMillis = config.uptimeMillis
  private val pause = config.pause
  private val sdkInt = config.sdkInt

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
      val node = findFocusedEditableNode(host.activeWindowRoot())
      val state =
        try {
          val hasUsableFocusedNode =
            node != null && node.refresh() && node.isEditable && node.isFocused && !node.isPassword
          if (hasUsableFocusedNode) {
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
      resultSender.sendFrame(requestId, "insert_text_state_result") { perfTiming ->
        insertTextStateResultFrame(requestId, state, perfTiming)
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
    SetTextOperation(requestId, text, resourceId, dismissKeyboard).run()
  }

  private inner class SetTextOperation(
    private val requestId: String?,
    private val text: String,
    private val resourceId: String?,
    private val dismissKeyboard: Boolean,
  ) {
    private val startTime = timeProvider.currentTimeMillis()

    // Never log the text: the target may be a password field.
    init {
      Log.d(TAG, "performSetText: ${text.length} chars resourceId=$resourceId")
      perfProvider.serial("performSetText")
    }

    suspend fun run() {
      try {
        perform()
      } catch (e: CancellationException) {
        perfProvider.end()
        throw e
      } catch (e: IllegalArgumentException) {
        reportFailure(e)
      } catch (e: IllegalStateException) {
        reportFailure(e)
      } catch (e: SecurityException) {
        reportFailure(e)
      }
    }

    private suspend fun perform() {
      perfProvider.startOperation("findNode")
      val targetNode = findSetTextTarget(host, resourceId)
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
      val success = applySetText(targetNode, text)
      perfProvider.endOperation("setText")
      perfProvider.end()

      Log.d(TAG, "Set text completed: success=$success")

      // Dismiss the soft keyboard if requested.
      // When enabled (via --dismiss-keyboard-after-input or per-call dismissKeyboard param),
      // SHOW_MODE_HIDDEN suppresses the keyboard globally for the accessibility service.
      // This prevents the keyboard from stealing touch events and accessibility focus
      // from UI elements behind it during subsequent tapOn steps.
      if (success && dismissKeyboard) {
        dismissSoftKeyboard()
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
    }

    private suspend fun reportFailure(e: Exception) {
      perfProvider.end()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing set text", e)
      broadcastSetTextResult(requestId, false, e.message, errorTime - startTime)
    }
  }

  private fun dismissSoftKeyboard() {
    try {
      host.hideSoftKeyboard()
      Log.d(TAG, "[KeyboardDismiss] Set SHOW_MODE_HIDDEN after text injection")
    } catch (e: CancellationException) {
      throw e
    } catch (e: IllegalStateException) {
      Log.w(TAG, "[KeyboardDismiss] softKeyboardController failed", e)
    } catch (e: SecurityException) {
      Log.w(TAG, "[KeyboardDismiss] softKeyboardController failed", e)
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
      } catch (e: java.io.IOException) {
        Log.w(TAG, "Failed to refresh hierarchy after text input", e)
      } catch (e: IllegalArgumentException) {
        Log.w(TAG, "Failed to refresh hierarchy after text input", e)
      } catch (e: IllegalStateException) {
        Log.w(TAG, "Failed to refresh hierarchy after text input", e)
      } catch (e: SecurityException) {
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
    InsertOperation(requestId, text, expectedSuffix, acceptsCaretNotPlaced, precedingState).run()
  }

  private data class InsertMutation(
    val succeeded: Boolean,
    val snapshot: InsertTextSnapshot?,
    val selectionAttempted: Boolean,
    val selectionReturned: Boolean,
    val nodeKey: InsertNodeKey,
  )

  private data class PreparedInsert(val plan: InsertTextPlan, val warning: String?)

  private inner class InsertOperation(
    private val requestId: String?,
    private val text: String,
    private val expectedSuffix: String?,
    private val acceptsCaretNotPlaced: Boolean,
    private val precedingState: InsertTextSnapshot?,
  ) {
    private val startTime = timeProvider.currentTimeMillis()
    // Suspend waits can resume on another IO thread; keep timing out of a thread-local stack.
    private val insertPerf = MutablePerfEntry("performInsertText", startTime)

    private fun finishPerf() {
      if (insertPerf.endTime == null) {
        insertPerf.endTime = timeProvider.currentTimeMillis()
        perfProvider.complete(insertPerf)
      }
    }

    private var nodeToRecycle: android.view.accessibility.AccessibilityNodeInfo? = null
    private val warnings = mutableListOf<String>()
    private var textMutated = false
    private lateinit var targetNode: android.view.accessibility.AccessibilityNodeInfo

    suspend fun run() {
      try {
        if (!initializeNode()) return
        val preparation = prepareInsert() ?: return
        val plan = preparation.plan
        val precedingWarning = preparation.warning

        applyInsert(plan, precedingWarning)
      } catch (e: CancellationException) {
        rememberedInsert = null
        nodeToRecycle?.recycle()
        finishPerf()
        throw e
      } catch (e: IllegalArgumentException) {
        reportFailure(e)
      } catch (e: IllegalStateException) {
        reportFailure(e)
      } catch (e: SecurityException) {
        reportFailure(e)
      }
    }

    private suspend fun initializeNode(): Boolean {
      val originalNode = findFocusedEditableNode(host.activeWindowRoot())
      if (originalNode == null) {
        rememberedInsert = null
        finishPerf()
        host.launchRequestScope(requestId) {
          broadcastInsertTextResult(
            InsertTextFrameResult(
              requestId = requestId,
              success = false,
              error = "No focused editable node found",
              totalTimeMs = timeProvider.currentTimeMillis() - startTime,
            ),
          )
        }
        return false
      }

      targetNode = originalNode
      nodeToRecycle = targetNode
      if (targetNode.isPassword) {
        rememberedInsert = null
        targetNode.recycle()
        nodeToRecycle = null
        finishPerf()
        broadcastInsertTextResult(
          InsertTextFrameResult(
            requestId = requestId,
            success = false,
            error = "Cannot insert text into a password field without exposing its original value",
            totalTimeMs = timeProvider.currentTimeMillis() - startTime,
          ),
        )
        return false
      }

      return true
    }

    private fun nodeKey() =
      InsertNodeKey(
        targetNode.windowId,
        targetNode.packageName?.toString(),
        targetNode.className?.toString(),
        targetNode.viewIdResourceName,
      )

    private fun readFreshSnapshot(): InsertTextSnapshot? {
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

    private suspend fun prepareInsert(): PreparedInsert? = InsertPreparation().prepare()

    private inner class InsertPreparation {
      // Every insert, including a caret-warning remainder, plans against a refreshed node.
      private var snapshot = readFreshSnapshot()
      private val waitStarted = uptimeMillis()
      private val remembered = rememberedInsert?.takeIf {
        it.first == nodeKey() && uptimeMillis() - it.second.atMs <= REMEMBER_TTL_MS
      }

      suspend fun prepare(): PreparedInsert? {
        if (remembered == null) rememberedInsert = null
        val rememberedTextMatched = remembered?.let {
          snapshot?.let { s -> !s.isShowingHintText && s.text.orEmpty() == it.second.caret.text }
        }
        awaitRememberedText(rememberedTextMatched)
        awaitPrecedingText()
        AutoMobileLog.d(
          TAG,
          "insertText rememberedTextMatchedInitially=${rememberedTextMatched == true} rememberedTextMatchedAfterWait=${remembered != null && snapshot?.text == remembered.second.caret.text && snapshot?.isShowingHintText == false} waitMs=${uptimeMillis() - waitStarted}",
        )
        val liveSnapshot = snapshot
        if (liveSnapshot == null) {
          rejectMissingSnapshot()
          return null
        }
        return plan(liveSnapshot)
      }

      private fun plan(liveSnapshot: InsertTextSnapshot): PreparedInsert {
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
            liveSnapshot,
            textToInsert = text,
            remembered = caret,
          )
        if (!plan.usedRememberedCaret) rememberedInsert = null
        val precedingWarning = warnings.takeIf { it.isNotEmpty() }?.joinToString(" ")
        AutoMobileLog.d(
          TAG,
          "insertText selectionBeforeStart=${liveSnapshot.selectionStart} selectionBeforeEnd=${liveSnapshot.selectionEnd} textLength=${liveSnapshot.text.orEmpty().length}",
        )

        return PreparedInsert(plan, precedingWarning)
      }

      private suspend fun awaitRememberedText(rememberedTextMatched: Boolean?) {
        if (remembered != null && snapshot != null && rememberedTextMatched == false) {
          val matched =
            awaitPrecedingInput(
              PrecedingInputExpectation(
                expectedSuffix = "",
                matches = { s ->
                  nodeKey() == remembered.first &&
                    !s.isShowingHintText &&
                    s.text.orEmpty() == remembered.second.caret.text
                },
              ),
              readSnapshot = { readFreshSnapshot().also { snapshot = it } },
              nowMs = { uptimeMillis() },
              pause = pause,
            )
          if (!matched) {
            rememberedInsert = null
            warnings.add(
              "The field changed since the previous insert; its text did not match within 300ms, so the reported selection was used",
            )
          }
        }
      }

      private suspend fun awaitPrecedingText() {
        if (snapshot != null && shouldWaitForPrecedingInput(expectedSuffix)) {
          val observed =
            awaitPrecedingInput(
              PrecedingInputExpectation(
                expectedSuffix = requireNotNull(expectedSuffix),
                baseline = precedingState,
              ),
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
      }

      private suspend fun rejectMissingSnapshot() {
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
          InsertTextFrameResult(
            requestId = requestId,
            success = false,
            error = error,
            totalTimeMs = timeProvider.currentTimeMillis() - startTime,
            warning = warnings.takeIf { it.isNotEmpty() }?.joinToString(" "),
          ),
        )
      }
    }

    private fun readMutationSnapshot(mutationNodeKey: InsertNodeKey): InsertTextSnapshot? {
      // After writing, never re-find and move a caret in a different focused field.
      val hasInvalidMutationTarget =
        !targetNode.refresh() ||
          nodeKey() != mutationNodeKey ||
          !targetNode.isEditable ||
          !targetNode.isFocused ||
          targetNode.isPassword
      if (hasInvalidMutationTarget) return null
      return InsertTextSnapshot(
        targetNode.text?.toString(),
        targetNode.isShowingHintTextCompat(),
        targetNode.textSelectionStart,
        targetNode.textSelectionEnd,
      )
    }

    private suspend fun applyInsert(plan: InsertTextPlan, precedingWarning: String?) {
      InsertApplication(plan, precedingWarning).apply()
    }

    private inner class InsertApplication(
      private val plan: InsertTextPlan,
      private val precedingWarning: String?,
    ) {
      suspend fun apply() {
        if (!supportsActions()) return
        val (
          setTextSucceeded, afterSetText, selectionAttempted, selectionReturned, mutationNodeKey) =
          mutate()
        // A widget may reject SET_SELECTION when SET_TEXT already placed the caret correctly.
        val observedSelection =
          if (selectionAttempted && !selectionReturned) readMutationSnapshot(mutationNodeKey)
          else afterSetText
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
          InsertTextFrameResult(
            requestId = requestId,
            success = outcome.success,
            error = outcome.error,
            totalTimeMs = timeProvider.currentTimeMillis() - startTime,
            partialApplication = outcome.partialApplication,
            warning = outcome.warning,
            caretPlaced = outcome.caretPlaced,
            resultingTextLength =
              if (setTextSucceeded && acceptsCaretNotPlaced) plan.updatedText.length else null,
          ),
        )
        if (setTextSucceeded) refreshHierarchyAfterTextInput()
      }

      private suspend fun supportsActions(): Boolean {
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
            InsertTextFrameResult(
              requestId = requestId,
              success = false,
              error = "Focused editable node does not support ${unsupportedAction.value}",
              totalTimeMs = timeProvider.currentTimeMillis() - startTime,
              warning = precedingWarning,
            ),
          )
          return false
        }

        return true
      }

      private suspend fun mutate(): InsertMutation {
        val setTextArguments =
          android.os.Bundle().apply {
            putCharSequence(
              android.view.accessibility.AccessibilityNodeInfo
                .ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
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
        val afterSetText =
          if (setTextSucceeded) {
            awaitInsertTextMutation(
              plan,
              readSnapshot = { readMutationSnapshot(mutationNodeKey) },
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
            placeInsertCaret(targetNode, plan.caret)
          } else false
        return InsertMutation(
          setTextSucceeded,
          afterSetText,
          selectionAttempted,
          selectionReturned,
          mutationNodeKey,
        )
      }
    }

    private suspend fun reportFailure(e: Exception) {
      rememberedInsert = null
      nodeToRecycle?.recycle()
      finishPerf()
      Log.e(TAG, "Error inserting text", e)
      broadcastInsertTextResult(
        InsertTextFrameResult(
          requestId = requestId,
          success = false,
          error = e.message,
          totalTimeMs = timeProvider.currentTimeMillis() - startTime,
          partialApplication = textMutated,
          warning = warnings.takeIf { it.isNotEmpty() }?.joinToString(" "),
        ),
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

  private suspend fun performNavigationAction(action: String): Boolean? {
    val navigationActionId =
      when (action) {
        "next" -> android.view.inputmethod.EditorInfo.IME_ACTION_NEXT
        "previous" -> android.view.inputmethod.EditorInfo.IME_ACTION_PREVIOUS
        else -> null
      }
    return if (navigationActionId != null) {
      host.performImeNavigationAction(navigationActionId)
    } else null
  }

  private fun executeImeStep(
    step: ImeActionStep,
    root: android.view.accessibility.AccessibilityNodeInfo?,
    focusedNode: android.view.accessibility.AccessibilityNodeInfo?,
    editorActionResult: Boolean?,
    action: String,
  ): Boolean {
    return when (step) {
      ImeActionStep.EDITOR_NEXT,
      ImeActionStep.EDITOR_PREVIOUS -> editorActionResult == true
      ImeActionStep.NEXT ->
        focusImeNeighbor(findNextFocusableNode(root, checkNotNull(focusedNode)), "next")
      ImeActionStep.PREVIOUS ->
        focusImeNeighbor(findPreviousFocusableNode(root, checkNotNull(focusedNode)), "previous")
      ImeActionStep.IME_ENTER ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          // API 30+: Use ACTION_IME_ENTER for proper IME action handling
          val actionId =
            android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id
          val imeResult = checkNotNull(focusedNode).performAction(actionId)
          Log.d(TAG, "ACTION_IME_ENTER result: $imeResult")
          imeResult
        } else sendImeEnter()
      ImeActionStep.KEYCODE_ENTER -> {
        sendImeEnter()
      }
      else -> {
        Log.w(TAG, "Unknown IME action: $action")
        false
      }
    }
  }

  private fun focusImeNeighbor(
    node: android.view.accessibility.AccessibilityNodeInfo?,
    direction: String,
  ): Boolean {
    if (node == null) {
      Log.w(TAG, "No $direction focusable node found")
      return false
    }
    val success = node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_FOCUS)
    node.recycle()
    return success
  }

  private fun sendImeEnter(): Boolean {
    // Pre-API 30: Fall back to pressing Enter key via input shell command
    // This is less reliable but works on older devices
    Log.d(TAG, "Pre-API 30: falling back to KEYCODE_ENTER")
    return try {
      host.sendKeycodeEnter()
    } catch (e: CancellationException) {
      throw e
    } catch (e: java.io.IOException) {
      Log.e(TAG, "Failed to send KEYCODE_ENTER", e)
      false
    } catch (e: InterruptedException) {
      Log.e(TAG, "Failed to send KEYCODE_ENTER", e)
      false
    } catch (e: SecurityException) {
      Log.e(TAG, "Failed to send KEYCODE_ENTER", e)
      false
    }
  }

  /**
   * Dispatch navigation through the active IME when possible, otherwise approximate it with focus
   * traversal. Other keyboard actions retain their AccessibilityService handling.
   */
  suspend fun performImeAction(requestId: String?, action: String) {
    rememberedInsert = null
    ImeActionOperation(requestId, action).run()
  }

  private inner class ImeActionOperation(
    private val requestId: String?,
    private val action: String,
  ) {
    private val startTime = timeProvider.currentTimeMillis()

    init {
      Log.d(TAG, "performImeAction: action='$action'")
      // Suspend waits can resume on another IO thread; keep timing out of a thread-local stack.
    }

    private val imePerf = MutablePerfEntry("performImeAction", startTime)

    private fun finishPerf() {
      if (imePerf.endTime == null) {
        imePerf.endTime = timeProvider.currentTimeMillis()
        perfProvider.complete(imePerf)
      }
    }

    private var root: android.view.accessibility.AccessibilityNodeInfo? = null
    private var focusedNode: android.view.accessibility.AccessibilityNodeInfo? = null
    private var approximated: Boolean? = null

    suspend fun run() {
      try {
        perform()
      } catch (e: CancellationException) {
        finishPerf()
        throw e
      } catch (e: java.io.IOException) {
        reportFailure(e)
      } catch (e: InterruptedException) {
        reportFailure(e)
      } catch (e: IllegalArgumentException) {
        reportFailure(e)
      } catch (e: IllegalStateException) {
        reportFailure(e)
      } catch (e: SecurityException) {
        reportFailure(e)
      } finally {
        if (focusedNode !== root) {
          focusedNode?.recycle()
        }
        root?.recycle()
      }
    }

    private suspend fun perform() {
      val findFocusedNodePerf =
        MutablePerfEntry("findFocusedNode", timeProvider.currentTimeMillis())
      imePerf.children.add(findFocusedNodePerf)
      root = host.activeWindowRoot()
      focusedNode = findFocusedEditableNode(root)
      findFocusedNodePerf.endTime = timeProvider.currentTimeMillis()

      val editorActionResult = performNavigationAction(action)
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
          broadcastImeActionResult(
            ImeActionFrameResult(
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

      complete(step, editorActionResult)
    }

    private suspend fun reportFailure(e: Exception) {
      finishPerf()
      val errorTime = timeProvider.currentTimeMillis()
      Log.e(TAG, "Error performing IME action", e)
      broadcastImeActionResult(
        ImeActionFrameResult(
          requestId = requestId,
          action = action,
          success = false,
          error = e.message,
          totalTimeMs = errorTime - startTime,
          approximated = approximated,
        ),
      )
    }

    private suspend fun complete(step: ImeActionStep, editorActionResult: Boolean?) {
      val executeActionPerf = MutablePerfEntry("executeAction", timeProvider.currentTimeMillis())
      imePerf.children.add(executeActionPerf)
      val success = executeImeStep(step, root, focusedNode, editorActionResult, action)
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
        ImeActionFrameResult(
          requestId = requestId,
          action = action,
          success = success,
          error = if (success) null else "Action failed",
          totalTimeMs = totalTime,
          approximated = approximated,
        ),
      )
    }
  }

  /**
   * Perform select all text using AccessibilityService's ACTION_SET_SELECTION. This is
   * significantly faster than using ADB double-tap gestures.
   */
  suspend fun performSelectAll(requestId: String?) {
    rememberedInsert = null
    SelectAllOperation(requestId).run()
  }

  private inner class SelectAllOperation(
    private val requestId: String?,
  ) {
    private val startTime = timeProvider.currentTimeMillis()

    init {
      Log.d(TAG, "performSelectAll")
      perfProvider.serial("performSelectAll")
    }

    suspend fun run() {
      try {
        perform()
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

    private suspend fun perform() {
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

      val outcome = applySelectAll(focusedNode, plan)
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
    }

    private suspend fun reportFailure(e: Exception) {
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
    resultSender.sendFrame(requestId, "set_text_result") { perfTiming ->
      setTextResultFrame(requestId, success, error, totalTimeMs, perfTiming)
    }
  }

  /** Broadcast insert text result to WebSocket clients. */
  private suspend fun broadcastInsertTextResult(outcome: InsertTextFrameResult) {
    resultSender.sendFrame(outcome.requestId, "insert_text_result") { perfTiming ->
      insertTextResultFrame(outcome, perfTiming)
    }
  }

  /** Broadcast IME action result to WebSocket clients */
  suspend fun broadcastImeActionResult(outcome: ImeActionFrameResult) {
    resultSender.sendFrame(outcome.requestId, "ime_action_result") { perfTiming ->
      imeActionResultFrame(outcome, perfTiming)
    }
  }

  /** Broadcast select all result to WebSocket clients */
  private suspend fun broadcastSelectAllResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    resultSender.sendFrame(requestId, "select_all_result") { perfTiming ->
      selectAllResultFrame(requestId, success, error, totalTimeMs, perfTiming)
    }
  }
}

/** `isShowingHintText` is API 26+; older platforms cannot report it, so treat the text as real. */
private fun AccessibilityNodeInfo.isShowingHintTextCompat(): Boolean =
  Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isShowingHintText

private fun placeInsertCaret(
  targetNode: android.view.accessibility.AccessibilityNodeInfo,
  caret: Int,
): Boolean {
  val selectionArguments =
    android.os.Bundle().apply {
      putInt(
        android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT,
        caret,
      )
      putInt(
        android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT,
        caret,
      )
    }
  return targetNode.performAction(
    android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION,
    selectionArguments,
  )
}

private fun findSetTextTarget(
  host: TextInputController.Host,
  resourceId: String?,
): AccessibilityNodeInfo? {
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
  return foundTargetNode
}

private fun applySetText(targetNode: AccessibilityNodeInfo, text: String): Boolean {
  val arguments =
    android.os.Bundle().apply {
      putCharSequence(
        android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
        text,
      )
    }
  return try {
    targetNode.performAction(
      android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT,
      arguments,
    )
  } finally {
    targetNode.recycle()
  }
}

private fun applySelectAll(
  focusedNode: AccessibilityNodeInfo,
  plan: SelectAllPlan,
): SelectAllOutcome {
  val textLength = plan.textLength
  return if (plan.shouldPerformAction) {
    // Use ACTION_SET_SELECTION with start=0 and end=textLength to select all
    val arguments =
      android.os.Bundle().apply {
        putInt(
          android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT,
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
    if (textLength == 0) Log.d("CtrlProxy", "No text in focused node to select")
    SelectAllOutcome(true, null)
  }
}
