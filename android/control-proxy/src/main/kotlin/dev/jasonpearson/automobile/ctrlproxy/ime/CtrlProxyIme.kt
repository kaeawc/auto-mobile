package dev.jasonpearson.automobile.ctrlproxy.ime

import android.content.ComponentName
import android.inputmethodservice.InputMethodService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
  private var lastPriorImeId: String? = null

  override fun onCreate() {
    super.onCreate()
    savedStateRegistryController.performRestore(null)
    lifecycleRegistry.currentState = Lifecycle.State.CREATED
    activeProfile = session.activeProfile()
    instance = this
  }

  override fun onDestroy() {
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
    session.onFinishInput(connectionAdapter())
    super.onFinishInput()
    restoreLastIme()
  }

  fun commitText(
    text: String,
    priorImeId: String?,
    onResult: (ImeCommitResult) -> Unit,
  ) {
    mainHandler.post {
      val driver = ImeCommitDriver(createSink())
      val restoreId = priorImeId?.takeUnless { it == ownImeId() }
      rememberRestore(driver, restoreId)
      awaitInputConnection(
        text = text,
        priorImeId = restoreId,
        driver = driver,
        deadlineMs = SystemClock.uptimeMillis() + INPUT_CONNECTION_TIMEOUT_MS,
        onResult = onResult,
      )
    }
  }

  private fun awaitInputConnection(
    text: String,
    priorImeId: String?,
    driver: ImeCommitDriver,
    deadlineMs: Long,
    onResult: (ImeCommitResult) -> Unit,
  ) {
    if (currentInputStarted && currentInputConnection != null) {
      onResult(driver.commit(text, priorImeId))
      scheduleIdleRestore(driver, priorImeId)
      return
    }
    if (SystemClock.uptimeMillis() >= deadlineMs) {
      driver.restoreIfNeeded(priorImeId)
      onResult(
        ImeCommitResult(success = false, error = "No active input connection within timeout")
      )
      scheduleIdleRestore(driver, priorImeId)
      return
    }
    mainHandler.postDelayed(
      {
        awaitInputConnection(text, priorImeId, driver, deadlineMs, onResult)
      },
      INPUT_CONNECTION_POLL_MS,
    )
  }

  private fun createSink(): ImeCommitSink =
    object : ImeCommitSink {
      override fun editorInputType(): Int? =
        if (currentInputStarted) currentInputEditorInfo?.inputType else null

      override fun commitChar(ch: CharSequence): Boolean =
        session.typeForAutomation(ch.toString(), connectionAdapter())

      override fun switchToIme(imeId: String) {
        switchInputMethod(imeId)
      }
    }

  private fun rememberRestore(driver: ImeCommitDriver, priorImeId: String?) {
    if (priorImeId == null) {
      idleRestore?.let(mainHandler::removeCallbacks)
      idleRestore = null
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
      driver.restoreIfNeeded(priorImeId)
      clearRememberedRestore(driver, priorImeId)
    }
    idleRestore = restore
    mainHandler.postDelayed(restore, IDLE_RESTORE_DELAY_MS)
  }

  private fun restoreLastIme() {
    val driver = lastDriver ?: return
    val priorImeId = lastPriorImeId ?: return
    driver.restoreIfNeeded(priorImeId)
    clearRememberedRestore(driver, priorImeId)
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
  private fun applyProfile(id: String) {
    connectionAdapter()?.let { connection ->
      InputConnectionDriver(connection).execute(listOf(ImeOp.FinishComposingText))
    }
    if (session.setActiveProfile(id)) activeProfile = session.activeProfile()
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
    private const val INPUT_CONNECTION_TIMEOUT_MS = 2_000L
    private const val INPUT_CONNECTION_POLL_MS = 50L
    private const val IDLE_RESTORE_DELAY_MS = 10_000L

    @Volatile private var instance: CtrlProxyIme? = null

    fun current(): CtrlProxyIme? = instance

    /**
     * Switches the live keyboard's profile. Callers may be on any thread (the CtrlProxy WebSocket
     * handler is not the main thread), so the swap is posted to the main looper where the session
     * is driven; a later posted automation commit therefore always runs under the new profile.
     * Returns false when no keyboard instance is running (the caller persists the id instead).
     */
    fun setActiveProfile(id: String): Boolean {
      val service = instance ?: return false
      service.mainHandler.post { service.applyProfile(id) }
      return true
    }
  }
}
