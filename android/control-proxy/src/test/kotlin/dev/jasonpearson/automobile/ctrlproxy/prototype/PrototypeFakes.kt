package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.Display
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceMode
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceSource
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow

/** A device whose light or dark setting and palette the test flips. */
internal class FakePrototypeDeviceAppearance(
  override var dark: Boolean = false,
  override var paletteKey: Int = 0,
) : PrototypeDeviceAppearance

/**
 * Whether [model]'s own spec fixes the mode (an explicit `light`/`dark`, a role surface override or
 * an authored background), or null when it is left to the system setting.
 */
internal fun prototypeSpecDark(model: PrototypeRenderModel): Boolean? =
  prototypeResolveAppearance(model.root, model.theme, deviceDark = false)
    .takeIf { it.source != PrototypeAppearanceSource.SYSTEM }
    ?.dark

/** The theme flow a controller show hands the host for [model], resolved on a light device. */
internal fun prototypeShownThemeFlow(
  model: PrototypeRenderModel,
  dark: Boolean? = null,
): MutableStateFlow<PrototypeShownTheme> {
  val resolved = prototypeResolveAppearance(model.root, model.theme, deviceDark = false)
  val appearance =
    if (dark == null) resolved
    else
      resolved.copy(
        mode = if (dark) PrototypeAppearanceMode.DARK else PrototypeAppearanceMode.LIGHT,
      )
  return MutableStateFlow(PrototypeShownTheme(model.root, model.theme, appearance))
}

internal class FakePrototypeMainThread : PrototypeMainThread {
  var onMain = true
  val pending = ArrayDeque<() -> Unit>()
  var acceptPosts = true

  override fun isMainThread() = onMain

  override fun post(work: () -> Unit): Boolean {
    if (!acceptPosts) return false
    pending.addLast(work)
    return true
  }

  fun drain() {
    val previous = onMain
    onMain = true
    try {
      while (pending.isNotEmpty()) pending.removeFirst().invoke()
    } finally {
      onMain = previous
    }
  }
}

internal class FakePrototypeSettleTimer(private val history: MutableList<String>) :
  PrototypeSettleTimer {
  val waits = mutableListOf<Long>()
  var gate: CompletableDeferred<Unit>? = null

  override suspend fun awaitSettle(millis: Long) {
    waits += millis
    history += "settle:$millis"
    gate?.await()
  }
}

/** Does not attach a real window or create a composition; records independent params snapshots. */
internal class RecordingPrototypeWindowManager(
  private val mainThread: FakePrototypeMainThread,
  private val history: MutableList<String>,
) : WindowManager {
  var view: View? = null
  val added = mutableListOf<WindowManager.LayoutParams>()
  val updated = mutableListOf<WindowManager.LayoutParams>()
  var removals = 0
  var failAdd = false
  var failUpdate = false
  var failRemove = false
  var updateFailure: Exception = IllegalStateException("fake update failure")
  var removeFailure: Exception = IllegalStateException("fake remove failure")

  override fun addView(view: View, params: ViewGroup.LayoutParams) {
    check(mainThread.isMainThread())
    history += "add"
    this.view = view
    if (failAdd) throw IllegalStateException("fake add failure")
    added += snapshot(params)
  }

  override fun updateViewLayout(view: View, params: ViewGroup.LayoutParams) {
    check(mainThread.isMainThread())
    if (failUpdate) throw updateFailure
    val copy = snapshot(params)
    updated += copy
    history +=
      if (copy.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE != 0) "untouchable"
      else "touchable"
  }

  override fun removeViewImmediate(view: View) {
    check(mainThread.isMainThread())
    if (failRemove) throw removeFailure
    removals++
    history += "remove"
  }

  override fun removeView(view: View) = error("Host must use removeViewImmediate")

  @Suppress("OVERRIDE_DEPRECATION")
  override fun getDefaultDisplay(): Display? = error("Host must use injected context density")

  private fun snapshot(params: ViewGroup.LayoutParams) =
    WindowManager.LayoutParams().apply { copyFrom(params as WindowManager.LayoutParams) }
}

internal class FakePrototypeHost : PrototypeHost {
  val calls = mutableListOf<String>()
  val requests = mutableListOf<PrototypeRequest>()
  var accept = true
  var failure: Exception? = null
  override var isShowing = false
  override var currentPlacement: PrototypePlacement? = null
  override val isTouchThroughActive = false

  private fun display(operation: String, request: PrototypeRequest): Boolean {
    calls += operation
    failure?.let { throw it }
    if (accept) {
      requests += request
      isShowing = true
      currentPlacement = request.placement
    }
    return accept
  }

  override suspend fun show(request: PrototypeRequest) = display("show", request)

  override suspend fun replace(request: PrototypeRequest) = display("replace", request)

  override suspend fun relayout(): Boolean {
    calls += "relayout"
    return accept
  }

  var acceptTextField = true

  override suspend fun setTextFieldVisible(visible: Boolean): Boolean {
    calls += "textField:$visible"
    if (!isShowing) return true
    if (acceptTextField) requests[requests.lastIndex] = requests.last().copy(hasTextField = visible)
    return acceptTextField
  }

  override suspend fun dismiss(): Boolean {
    calls += "dismiss"
    failure?.let { throw it }
    if (accept) isShowing = false
    return accept
  }

  override suspend fun destroy(): Boolean {
    calls += "destroy"
    failure?.let { throw it }
    if (accept) isShowing = false
    return accept
  }

  override suspend fun setOpacity(percent: Int) {
    calls += "opacity:$percent"
  }

  override suspend fun <T> withTouchThrough(settleMillis: Long, block: suspend () -> T): T = block()

  override suspend fun <T> withHiddenForCapture(
    frameTimeoutMillis: Long,
    maxHiddenMillis: Long,
    block: suspend () -> T,
  ): PrototypeHiddenCapture<T> {
    calls += "hideForCapture"
    return PrototypeHiddenCapture(block(), prototypeExcluded = true)
  }
}

/**
 * Fake display provider: a display is available only while it is in [connected]. Each opened
 * display gets its own recording WindowManager sharing [history], so cross-display ordering shows.
 */
internal class FakePrototypeDisplays(
  private val main: FakePrototypeMainThread,
  private val history: MutableList<String>,
  private val context: android.content.Context,
) : PrototypeDisplayProvider, PrototypeDisplayWindows {
  val connected = mutableSetOf<Int>()
  val densities = mutableMapOf<Int, Float>()
  val opened = mutableListOf<Int>()
  /** The window-context layer each [opened] entry was created for, in the same order. */
  val openedLayers = mutableListOf<PrototypeWindowLayer>()
  val managers = mutableMapOf<Int, RecordingPrototypeWindowManager>()

  fun connect(displayId: Int, density: Float = 2f): RecordingPrototypeWindowManager {
    connected += displayId
    densities[displayId] = density
    return managers.getOrPut(displayId) { RecordingPrototypeWindowManager(main, history) }
  }

  override fun isAvailable(displayId: Int) = displayId == 0 || displayId in connected

  override fun open(displayId: Int, layer: PrototypeWindowLayer): PrototypeDisplayWindow? {
    if (displayId !in connected) return null
    opened += displayId
    openedLayers += layer
    return PrototypeDisplayWindow(context, managers.getValue(displayId)) {
      densities.getValue(displayId)
    }
  }
}

/** Virtual one-shot scheduler; cancelled callbacks can also be exercised to model queue races. */
internal class FakePrototypeTimer : PrototypeScheduler {
  internal data class Task(
    val deadline: Long,
    val action: suspend () -> Unit,
    var cancelled: Boolean = false,
    var fired: Boolean = false,
  )

  var now = 0L
    private set

  val tasks = mutableListOf<Task>()

  override fun schedule(millis: Long, action: suspend () -> Unit): PrototypeScheduledTask {
    val task = Task(now + millis, action)
    tasks += task
    return PrototypeScheduledTask { task.cancelled = true }
  }

  suspend fun advance(millis: Long) {
    now += millis
    for (task in tasks.toList()) {
      if (!task.cancelled && !task.fired && task.deadline <= now) {
        task.fired = true
        task.action()
      }
    }
  }
}
