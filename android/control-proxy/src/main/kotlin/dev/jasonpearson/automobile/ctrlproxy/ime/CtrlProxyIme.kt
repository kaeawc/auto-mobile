package dev.jasonpearson.automobile.ctrlproxy.ime

import android.content.ComponentName
import android.inputmethodservice.InputMethodService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.EditorConfig
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.KeyboardController
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.ImeOp
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.KeyboardProfiles
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.ui.KeyboardCallbacks
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.ui.KeyboardScreen
import dev.jasonpearson.automobile.ctrlproxy.ime.session.ImeConnection
import dev.jasonpearson.automobile.ctrlproxy.ime.session.ImeSwitcher
import dev.jasonpearson.automobile.ctrlproxy.ime.session.InputConnectionAdapter
import dev.jasonpearson.automobile.ctrlproxy.ime.session.InputConnectionDriver
import dev.jasonpearson.automobile.ctrlproxy.ime.session.KeyboardSession
import dev.jasonpearson.automobile.ctrlproxy.ime.session.SharedPreferencesKeyboardProfileStore
import dev.jasonpearson.automobile.protocol.ImeTextDelivery
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class CtrlProxyIme : InputMethodService(), LifecycleOwner, SavedStateRegistryOwner {
  private val lifecycleRegistry = LifecycleRegistry(this)
  private val savedStateRegistryController = SavedStateRegistryController.create(this)
  override val lifecycle: Lifecycle = lifecycleRegistry
  override val savedStateRegistry: SavedStateRegistry =
    savedStateRegistryController.savedStateRegistry
  private val session by lazy {
    KeyboardSession(
      KeyboardController(),
      SharedPreferencesKeyboardProfileStore(this),
      object : ImeSwitcher {
        override fun switchToPrevious() {
          if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P || !switchToPreviousInputMethod()) {
            getSystemService(InputMethodManager::class.java).showInputMethodPicker()
          }
        }
      },
    )
  }
  private var uiState by mutableStateOf(KeyboardController().uiState())
  private var activeProfile by mutableStateOf(KeyboardProfiles.DEFAULT)
  private val mainHandler by lazy { Handler(Looper.getMainLooper()) }
  private var idleRestore: Runnable? = null
  private var lastDriver: ImeCommitDriver? = null
  private var activeDriver: ImeCommitDriver? = null
  private var cancelActiveCommit: ((String) -> Unit)? = null
  private var lastPriorImeId: String? = null
  private val traceRecorder =
    ImeTraceRecorder(
      elapsedRealtimeMs = SystemClock::elapsedRealtime,
      emit = { Log.i(ImeTraceRecorder.TAG, it) },
    )
  private var tracedConnectionIdentity: Int? = null

  internal fun traceSnapshot(): List<String> = traceRecorder.snapshot()

  private fun recordTrace(event: String, vararg fields: Pair<String, Any?>) {
    runCatching {
      traceRecorder.record(
        event,
        "gen" to inputConnectionGeneration,
        "commitActive" to (activeDriver != null),
        "commit" to if (activeDriver != null) commitGeneration else null,
        *fields,
      )
    }
  }

  private fun traceCallback(
    event: String,
    vararg fields: Pair<String, Any?>,
    editorInfo: EditorInfo? = null,
  ) {
    runCatching {
      val connection = currentInputConnection
      val identity = connection?.let(System::identityHashCode)
      if (identity != tracedConnectionIdentity) {
        recordTrace(
          "connectionReplaced",
          "hadConnection" to (tracedConnectionIdentity != null),
          "hasConnection" to (connection != null),
        )
        tracedConnectionIdentity = identity
      }
      when {
        event == "onStartInput" || event == "onStartInputView" ->
          recordTrace(event, *fields, *editorFields(editorInfo))
        event == "onUpdateSelection" &&
          ImeCommitDriver.isPasswordInput(currentInputEditorInfo?.inputType) ->
          recordTrace(event, "secure" to true)
        else -> recordTrace(event, *fields)
      }
    }
  }

  private fun editorFields(info: EditorInfo?): Array<Pair<String, Any?>> =
    if (info == null) arrayOf("editor" to "none")
    else editorTraceFields(info.packageName, info.fieldId, info.inputType, info.imeOptions)

  override fun onBindInput() {
    super.onBindInput()
    traceCallback("onBindInput")
  }

  override fun onUnbindInput() {
    super.onUnbindInput()
    traceCallback("onUnbindInput")
  }

  private var commitGeneration = 0L
  internal var inputConnectionGeneration = 0L
    private set

  internal var inputEditorIdentity: String? = null
    private set

  internal var inputStartedByRestart = false
    private set

  internal var isInputStarted = false
    private set

  override fun onCreate() {
    super.onCreate()
    savedStateRegistryController.performRestore(null)
    lifecycleRegistry.currentState = Lifecycle.State.CREATED
    activeProfile = session.activeProfile()
    instance = this
  }

  override fun onDestroy() {
    cancelActiveCommit?.invoke("IME service destroyed during commit")
    commitGeneration++
    idleRestore?.let(mainHandler::removeCallbacks)
    if (instance === this) instance = null
    // InputMethodService.onDestroy() finishes the input view, which calls onFinishInputView();
    // run it while the lifecycle is still live, then mark it destroyed.
    super.onDestroy()
    moveLifecycleTo(Lifecycle.State.DESTROYED)
  }

  override fun onCreateInputView(): View {
    window.window?.decorView?.setViewTreeLifecycleOwner(this)
    window.window?.decorView?.setViewTreeSavedStateRegistryOwner(this)
    return ComposeView(this).apply {
      setViewTreeLifecycleOwner(this@CtrlProxyIme)
      setViewTreeSavedStateRegistryOwner(this@CtrlProxyIme)
      setContent {
        KeyboardScreen(
          uiState = uiState,
          profile = activeProfile,
          profiles = KeyboardProfiles.all,
          callbacks =
            KeyboardCallbacks(
              onKey = { key -> uiState = session.onKey(key, connectionAdapter()) },
              onSelectProfile = { id -> applyProfile(id) },
              onShowImePicker = {
                getSystemService(InputMethodManager::class.java).showInputMethodPicker()
              },
            ),
        )
      }
    }
  }

  override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
    super.onStartInputView(info, restarting)
    moveLifecycleTo(Lifecycle.State.RESUMED)
    traceCallback("onStartInputView", "restarting" to restarting, editorInfo = info)
  }

  override fun onFinishInputView(finishingInput: Boolean) {
    moveLifecycleTo(Lifecycle.State.STARTED)
    super.onFinishInputView(finishingInput)
    traceCallback("onFinishInputView", "finishingInput" to finishingInput)
  }

  override fun onEvaluateFullscreenMode(): Boolean = false

  override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
    super.onStartInput(attribute, restarting)
    inputConnectionGeneration++
    inputStartedByRestart = restarting
    inputEditorIdentity = attribute?.let { info ->
      listOf(
          info.packageName,
          info.fieldId.toString(),
          info.inputType.toString(),
          info.imeOptions.toString(),
          info.hintText?.toString(),
          info.fieldName,
        )
        .joinToString("") { value -> if (value == null) "-1:" else "${value.length}:$value" }
    }
    traceCallback("onStartInput", "restarting" to restarting, editorInfo = attribute)
    isInputStarted = true
    if (attribute != null) {
      uiState =
        session.onStartInput(
          EditorConfig(attribute.inputType, attribute.imeOptions),
          attribute.initialSelStart,
          attribute.initialSelEnd,
        )
      activeProfile = session.activeProfile()
    }
  }

  override fun onUpdateSelection(
    oldSelStart: Int,
    oldSelEnd: Int,
    newSelStart: Int,
    newSelEnd: Int,
    candidatesStart: Int,
    candidatesEnd: Int,
  ) {
    super.onUpdateSelection(
      oldSelStart,
      oldSelEnd,
      newSelStart,
      newSelEnd,
      candidatesStart,
      candidatesEnd,
    )
    session.onUpdateSelection(
      newSelStart,
      newSelEnd,
      candidatesStart,
      candidatesEnd,
      connectionAdapter(),
    )
    uiState = session.uiState()
    if (activeDriver != null) {
      traceCallback(
        "onUpdateSelection",
        "oldSelStart" to oldSelStart,
        "oldSelEnd" to oldSelEnd,
        "newSelStart" to newSelStart,
        "newSelEnd" to newSelEnd,
        "candidatesStart" to candidatesStart,
        "candidatesEnd" to candidatesEnd,
      )
    }
  }

  override fun onFinishInput() {
    isInputStarted = false
    inputConnectionGeneration++
    inputEditorIdentity = null
    session.onFinishInput(connectionAdapter())
    super.onFinishInput()
    if (cancelActiveCommit == null) restoreLastIme()
    traceCallback("onFinishInput")
  }

  /** Null means no active editor connection; false means the editor rejected the action. */
  internal suspend fun performNavigationAction(actionId: Int): Boolean? =
    withContext(Dispatchers.Main.immediate) {
      val selectedIme =
        Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
          ?.let(ComponentName::unflattenFromString)
      dispatchNavigationAction(
        actionId,
        isActive =
          instance === this@CtrlProxyIme &&
            selectedIme == ComponentName(this@CtrlProxyIme, CtrlProxyIme::class.java),
        isInputStarted,
        connectionAdapter(),
      )
    }

  fun commitText(request: ImeCommitRequest, onResult: (ImeCommitResult) -> Unit) {
    mainHandler.post {
      if (request.isCancelled()) {
        onResult(ImeCommitResult(success = false, error = "IME commit cancelled"))
        return@post
      }
      // A previous request can still have delayed conversion polls queued after its response
      // deadline. Cancel it before starting another request, and fence every later callback.
      cancelActiveCommit?.invoke("IME commit superseded by another request")
      commitGeneration++
      val generation = commitGeneration
      val driver =
        ImeCommitDriver(
          createSink(),
          trace =
            object : ImeDriverTrace {
              override fun record(event: String, fields: Array<out Pair<String, Any?>>) {
                recordTrace(event, *fields)
              }
            },
        )
      activeDriver = driver
      val secureInput = ImeCommitDriver.isPasswordInput(currentInputEditorInfo?.inputType)
      recordTrace(
        "commitStart",
        "delivery" to request.delivery.name,
        "textLength" to if (secureInput) null else request.text.length,
        "secure" to if (secureInput) true else null,
      )
      val restoreId = request.priorImeId?.takeUnless { it == ownImeId() }
      rememberRestore(driver, restoreId)
      var finished = false
      fun finish(result: ImeCommitResult) {
        if (finished) return
        finished = true
        recordTrace(
          "commitFinish",
          "success" to result.success,
          "partial" to result.partialApplication,
          "committedUnits" to result.committedUnits,
          "insertedLength" to result.insertedText?.length,
        )
        val tracedResult =
          if (request.trace) result.copy(trace = traceRecorder.snapshot()) else result
        if (activeDriver === driver) {
          activeDriver = null
          cancelActiveCommit = null
        }
        onResult(tracedResult)
      }
      cancelActiveCommit = { reason ->
        driver.cancel(reason)
        finish(ImeCommitResult(success = false, error = reason))
      }
      awaitInputConnection(
        request.copy(priorImeId = restoreId),
        ImeConnectionWait(
          driver = driver,
          deadlineMs = connectionDeadlineMs(SystemClock.uptimeMillis(), request.requestDeadlineMs),
          generation = generation,
          commitBudgetMs =
            commitTimeoutMs(request.timeoutMs, ImeGraphemes.split(request.text).size),
        ),
        onResult = ::finish,
      )
    }
  }

  private fun awaitInputConnection(
    request: ImeCommitRequest,
    wait: ImeConnectionWait,
    onResult: (ImeCommitResult) -> Unit,
  ) {
    val priorImeId = request.priorImeId
    val isCancelled = request.isCancelled
    val delivery = request.delivery
    val requestDeadlineMs = request.requestDeadlineMs
    val driver = wait.driver
    val deadlineMs = wait.deadlineMs
    val generation = wait.generation
    val commitBudgetMs = wait.commitBudgetMs

    if (generation != commitGeneration) return
    if (isCancelled()) {
      onResult(ImeCommitResult(success = false, error = "IME commit cancelled"))
      return
    }
    if (SystemClock.uptimeMillis() >= requestDeadlineMs) {
      driver.restoreIfNeeded(priorImeId)
      onResult(ImeCommitResult(success = false, error = "IME commit deadline exceeded"))
      return
    }
    val connection = currentInputConnection
    if (isInputStarted && connection != null) {
      if (delivery == ImeTextDelivery.CLEAR_FIELD) {
        val result = ConnectedField(connection).clear()
        driver.restoreIfNeeded(priorImeId)
        onResult(result)
        if (generation == commitGeneration) scheduleIdleRestore(driver, priorImeId)
        return
      }
      driver.commit(
        request,
        deadlineMs = SystemClock.uptimeMillis() + commitBudgetMs,
        hardDeadlineMs = driverDeadlineMs(SystemClock.uptimeMillis(), requestDeadlineMs),
      ) { result ->
        onResult(result)
        if (generation == commitGeneration) scheduleIdleRestore(driver, priorImeId)
      }
      return
    }
    if (SystemClock.uptimeMillis() >= deadlineMs) {
      driver.restoreIfNeeded(priorImeId)
      onResult(
        ImeCommitResult(success = false, error = "No active input connection within timeout"),
      )
      scheduleIdleRestore(driver, priorImeId)
      return
    }
    mainHandler.postDelayed(
      {
        awaitInputConnection(request, wait, onResult)
      },
      minOf(INPUT_CONNECTION_POLL_MS, deadlineMs - SystemClock.uptimeMillis()).coerceAtLeast(0),
    )
  }

  private inner class ConnectedField(
    private val connection: android.view.inputmethod.InputConnection,
  ) {
    fun clear(): ImeCommitResult {
      val cleared =
        clearImeField(
          finishComposing = connection::finishComposingText,
          readBefore = { connection.getTextBeforeCursor(it, 0) },
          readAfter = { connection.getTextAfterCursor(it, 0) },
          deleteSurrounding = connection::deleteSurroundingText,
        )
      return if (
        cleared.success &&
          !editorSyncSucceeded(InputConnectionAdapter(connection, this@CtrlProxyIme))
      )
        cleared.copy(
          success = false,
          error = "Input connection lost while syncing clear",
          partialApplication = true,
        )
      else cleared
    }
  }

  private fun createSink(): ImeCommitSink =
    object : ImeCommitSink {
      override fun nowMs(): Long = SystemClock.uptimeMillis()

      override fun connectionGeneration(): Long = inputConnectionGeneration

      override fun editorIdentity(): String? = inputEditorIdentity

      override fun startedByRestart(): Boolean = inputStartedByRestart

      override fun readEditorTextBeforeCursor(maxChars: Int): String? = runCatching {
        if (isInputStarted) currentInputConnection?.getTextBeforeCursor(maxChars, 0)?.toString()
        else null
      }
        .getOrNull()

      override fun editorInputType(): Int? =
        if (isInputStarted) currentInputEditorInfo?.inputType else null

      override fun commitChar(ch: CharSequence): Boolean =
        session.typeForAutomation(ch.toString(), connectionAdapter())

      override fun supportsKeyEvents(units: List<String>): Boolean = units.all { unit ->
        keyEventsFor(unit) != null
      }

      override fun sendKeyEventUnit(unit: String): Boolean {
        val connection = currentInputConnection ?: return false
        val events = keyEventsFor(unit) ?: return false
        var accepted = true
        for (event in events) {
          val softEvent = KeyEvent.changeFlags(event, event.flags or KeyEvent.FLAG_SOFT_KEYBOARD)
          accepted =
            runCatching { connection.sendKeyEvent(softEvent) }.getOrDefault(false) && accepted
        }
        return accepted
      }

      override fun finishComposing(): Boolean =
        session.finishComposingForAutomation(connectionAdapter())

      override fun readTextBeforeCursor(maxChars: Int): String? =
        connectionAdapter()?.textBeforeCursor(maxChars)

      override fun postDelayed(delayMs: Long, action: () -> Unit) {
        mainHandler.postDelayed(action, delayMs)
      }

      override fun syncEditorState(): Boolean = editorSyncSucceeded(connectionAdapter())

      override fun switchToIme(imeId: String) {
        switchInputMethod(imeId)
      }
    }

  private fun keyEventsFor(unit: String): Array<KeyEvent>? {
    if (unit.length != 1 || unit[0] !in ' '..'~') return null
    val events =
      KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(unit.toCharArray())
    return events?.takeIf { sequence ->
      sequence.isNotEmpty() &&
        sequence.all { it.action == KeyEvent.ACTION_DOWN || it.action == KeyEvent.ACTION_UP }
    }
  }

  private fun rememberRestore(driver: ImeCommitDriver, priorImeId: String?) {
    idleRestore?.let(mainHandler::removeCallbacks)
    idleRestore = null
    if (priorImeId == null) {
      lastDriver = null
      lastPriorImeId = null
      return
    }
    lastDriver = driver
    lastPriorImeId = priorImeId
  }

  private fun scheduleIdleRestore(driver: ImeCommitDriver, priorImeId: String?) {
    idleRestore?.let(mainHandler::removeCallbacks)
    if (priorImeId == null) {
      idleRestore = null
      return
    }
    val restore = Runnable {
      if (lastDriver !== driver) return@Runnable
      driver.restoreIfNeeded(priorImeId)
      clearRememberedRestore(driver, priorImeId)
    }
    idleRestore = restore
    mainHandler.postDelayed(restore, IDLE_RESTORE_DELAY_MS)
  }

  private fun restoreLastIme() {
    val driver = lastDriver ?: return
    val priorImeId = lastPriorImeId ?: return
    clearRememberedRestore(driver, priorImeId)
    driver.restoreIfNeeded(priorImeId)
  }

  // A destroyed LifecycleRegistry rejects every further transition, and the platform can deliver
  // input-view callbacks during teardown; never move a destroyed lifecycle.
  private fun moveLifecycleTo(state: Lifecycle.State) {
    if (lifecycleRegistry.currentState != Lifecycle.State.DESTROYED) {
      lifecycleRegistry.currentState = state
    }
  }

  // Finish any live composition first: the new profile's policy starts with an empty composing
  // buffer, so a surviving composing span would be overwritten by its next setComposingText.
  private fun applyProfile(id: String): Boolean {
    connectionAdapter()?.let { connection ->
      InputConnectionDriver(connection).execute(listOf(ImeOp.FinishComposingText))
    }
    if (!session.setActiveProfile(id)) return false
    activeProfile = session.activeProfile()
    return true
  }

  private fun connectionAdapter(): ImeConnection? = currentInputConnection?.let {
    InputConnectionAdapter(it, this)
  }

  private fun ownImeId(): String =
    ComponentName(this, CtrlProxyIme::class.java).flattenToShortString()

  private fun clearRememberedRestore(driver: ImeCommitDriver, priorImeId: String?) {
    if (lastDriver !== driver || lastPriorImeId != priorImeId) return
    idleRestore?.let(mainHandler::removeCallbacks)
    idleRestore = null
    lastDriver = null
    lastPriorImeId = null
  }

  companion object {
    internal fun dispatchNavigationAction(
      actionId: Int,
      isActive: Boolean,
      isInputStarted: Boolean,
      connection: ImeConnection?,
    ): Boolean? {
      if (actionId != EditorInfo.IME_ACTION_NEXT && actionId != EditorInfo.IME_ACTION_PREVIOUS)
        return null
      if (!isActive || !isInputStarted || connection == null) return null
      return connection.performEditorAction(actionId)
    }

    internal fun connectionDeadlineMs(nowMs: Long, requestDeadlineMs: Long): Long =
      minOf(nowMs + INPUT_CONNECTION_TIMEOUT_MS, requestDeadlineMs)

    internal fun driverDeadlineMs(nowMs: Long, requestDeadlineMs: Long): Long =
      if (requestDeadlineMs == Long.MAX_VALUE) Long.MAX_VALUE
      else
        minOf(
          requestDeadlineMs,
          maxOf(nowMs + 1, requestDeadlineMs - ImeCommitDriver.SYNC_RETRY_RESERVE_MS),
        )

    internal fun commitTimeoutMs(timeoutMs: Long?, unitCount: Int): Long =
      if (timeoutMs != null && timeoutMs > 0L) {
        minOf(COMMIT_TIMEOUT_CAP_MS, timeoutMs)
      } else {
        minOf(
          COMMIT_TIMEOUT_CAP_MS,
          maxOf(COMMIT_TIMEOUT_MS, COMMIT_TIMEOUT_MS + 30L * unitCount.coerceAtLeast(0)),
        )
      }

    /** A prompt null/empty read is valid; an exception or timed-out read is not. */
    internal fun editorSyncSucceeded(
      connection: ImeConnection?,
      nowMs: () -> Long = SystemClock::uptimeMillis,
    ): Boolean {
      if (connection == null) return false
      val startedMs = nowMs()
      return runCatching {
          connection.textBeforeCursorOrNull(1)
          nowMs() - startedMs < INPUT_CONNECTION_SYNC_TIMEOUT_MS
        }
        .getOrDefault(false)
    }

    private const val INPUT_CONNECTION_SYNC_TIMEOUT_MS = 2_000L
    internal const val INPUT_CONNECTION_TIMEOUT_MS = 2_000L
    internal const val COMMIT_TIMEOUT_MS = 4_000L
    private const val COMMIT_TIMEOUT_CAP_MS = 25_000L
    internal const val INPUT_CONNECTION_POLL_MS = 50L
    private const val IDLE_RESTORE_DELAY_MS = 10_000L

    @Volatile private var instance: CtrlProxyIme? = null

    fun current(): CtrlProxyIme? = instance

    /**
     * Switches the live keyboard's profile. Callers may be on any thread (the CtrlProxy WebSocket
     * handler is not the main thread), so the swap is posted to the main looper where the session
     * is driven; a later posted automation commit therefore always runs under the new profile.
     * Returns false when no keyboard instance is running (the caller persists the id instead). The
     * callback runs after the live session has applied and persisted the profile.
     */
    fun setActiveProfile(id: String, onComplete: (Boolean) -> Unit): Boolean {
      val service = instance ?: return false
      postProfileChange(
        { action -> service.mainHandler.post(action) },
        { service.applyProfile(id) },
        onComplete,
      )
      return true
    }

    internal fun postProfileChange(
      post: (Runnable) -> Boolean,
      apply: () -> Boolean,
      onComplete: (Boolean) -> Unit,
    ) {
      if (!post(Runnable { onComplete(apply()) })) onComplete(false)
    }
  }
}
