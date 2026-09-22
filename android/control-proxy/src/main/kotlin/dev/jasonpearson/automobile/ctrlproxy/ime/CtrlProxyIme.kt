package dev.jasonpearson.automobile.ctrlproxy.ime

import android.inputmethodservice.InputMethodService
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View

class CtrlProxyIme : InputMethodService() {
  private val mainHandler by lazy { Handler(Looper.getMainLooper()) }
  private var idleRestore: Runnable? = null
  private var lastDriver: ImeCommitDriver? = null
  private var lastPriorImeId: String? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onDestroy() {
    idleRestore?.let(mainHandler::removeCallbacks)
    if (instance === this) instance = null
    super.onDestroy()
  }

  override fun onCreateInputView(): View? = null

  override fun onEvaluateInputViewShown(): Boolean = false

  override fun onEvaluateFullscreenMode(): Boolean = false

  override fun onFinishInput() {
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
      rememberRestore(driver, priorImeId)
      awaitInputConnection(
        text = text,
        priorImeId = priorImeId,
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
    if (currentInputConnection != null) {
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
      override fun editorInputType(): Int? = currentInputEditorInfo?.inputType

      override fun commitChar(ch: CharSequence): Boolean =
        currentInputConnection?.commitText(ch, NEW_CURSOR_POSITION) ?: false

      override fun switchToIme(imeId: String) {
        switchInputMethod(imeId)
      }
    }

  private fun rememberRestore(driver: ImeCommitDriver, priorImeId: String?) {
    lastDriver = driver
    lastPriorImeId = priorImeId
  }

  private fun scheduleIdleRestore(driver: ImeCommitDriver, priorImeId: String?) {
    idleRestore?.let(mainHandler::removeCallbacks)
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
    private const val NEW_CURSOR_POSITION = 1

    @Volatile private var instance: CtrlProxyIme? = null

    fun current(): CtrlProxyIme? = instance
  }
}
