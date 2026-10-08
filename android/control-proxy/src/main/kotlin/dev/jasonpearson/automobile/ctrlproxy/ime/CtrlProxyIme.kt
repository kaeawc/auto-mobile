package dev.jasonpearson.automobile.ctrlproxy.ime

import android.content.ComponentName
import android.inputmethodservice.InputMethodService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
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
  private var commitGeneration = 0L
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
  }

  override fun onFinishInputView(finishingInput: Boolean) {
    moveLifecycleTo(Lifecycle.State.STARTED)
    super.onFinishInputView(finishingInput)
  }

  override fun onEvaluateFullscreenMode(): Boolean = false

  override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
    super.onStartInput(attribute, restarting)
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
  }

  override fun onFinishInput() {
    isInputStarted = false
    cancelActiveCommit?.invoke("Editor disconnected during IME commit")
    commitGeneration++
    session.onFinishInput(connectionAdapter())
    super.onFinishInput()
    restoreLastIme()
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

  fun commitText(
    text: String,
    priorImeId: String?,
    isCancelled: () -> Boolean = { false },
    delivery: ImeTextDelivery = ImeTextDelivery.COMMIT,
    timeoutMs: Long? = null,
    onResult: (ImeCommitResult) -> Unit,
  ) {
    mainHandler.post {
      if (isCancelled()) {
        onResult(ImeCommitResult(success = false, error = "IME commit cancelled"))
        return@post
      }
      // A previous request can still have delayed conversion polls queued after its response
      // deadline. Cancel it before starting another request, and fence every later callback.
      cancelActiveCommit?.invoke("IME commit superseded by another request")
      commitGeneration++
      val generation = commitGeneration
      val driver = ImeCommitDriver(createSink())
      activeDriver = driver
      val restoreId = priorImeId?.takeUnless { it == ownImeId() }
      rememberRestore(driver, restoreId)
      var finished = false
      fun finish(result: ImeCommitResult) {
        if (finished) return
        finished = true
        if (activeDriver === driver) {
          activeDriver = null
          cancelActiveCommit = null
        }
        onResult(result)
      }
      cancelActiveCommit = { reason ->
        driver.cancel(reason)
        finish(ImeCommitResult(success = false, error = reason))
      }
      awaitInputConnection(
        text = text,
        priorImeId = restoreId,
        driver = driver,
        deadlineMs = SystemClock.uptimeMillis() + INPUT_CONNECTION_TIMEOUT_MS,
        generation = generation,
        isCancelled = isCancelled,
        delivery = delivery,
        commitBudgetMs = commitTimeoutMs(timeoutMs, ImeGraphemes.split(text).size),
        onResult = ::finish,
      )
    }
  }

  private fun awaitInputConnection(
    text: String,
    priorImeId: String?,
    driver: ImeCommitDriver,
    deadlineMs: Long,
    generation: Long,
    isCancelled: () -> Boolean,
    delivery: ImeTextDelivery,
    commitBudgetMs: Long,
    onResult: (ImeCommitResult) -> Unit,
  ) {
    if (generation != commitGeneration) return
    if (isCancelled()) {
      onResult(ImeCommitResult(success = false, error = "IME commit cancelled"))
      return
    }
    val connection = currentInputConnection
    if (isInputStarted && connection != null) {
      if (delivery == ImeTextDelivery.CLEAR_FIELD) {
        val cleared =
          clearImeField(
            finishComposing = connection::finishComposingText,
            readBefore = { connection.getTextBeforeCursor(it, 0) },
            readAfter = { connection.getTextAfterCursor(it, 0) },
            deleteSurrounding = connection::deleteSurroundingText,
          )
        val result =
          if (cleared.success && !editorSyncSucceeded(InputConnectionAdapter(connection, this)))
            cleared.copy(
              success = false,
              error = "Input connection lost while syncing clear",
              partialApplication = true,
            )
          else cleared
        driver.restoreIfNeeded(priorImeId)
        onResult(result)
        if (generation == commitGeneration) scheduleIdleRestore(driver, priorImeId)
        return
      }
      driver.commit(
        text,
        priorImeId,
        SystemClock.uptimeMillis() + commitBudgetMs,
        isCancelled,
        delivery,
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
        awaitInputConnection(
          text,
          priorImeId,
          driver,
          deadlineMs,
          generation,
          isCancelled,
          delivery,
          commitBudgetMs,
          onResult,
        )
      },
      INPUT_CONNECTION_POLL_MS,
    )
  }

  private fun createSink(): ImeCommitSink =
    object : ImeCommitSink {
      override fun nowMs(): Long = SystemClock.uptimeMillis()

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
