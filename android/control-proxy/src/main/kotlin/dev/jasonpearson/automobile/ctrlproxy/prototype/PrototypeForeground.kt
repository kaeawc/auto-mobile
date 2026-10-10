package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.accessibility.AccessibilityWindowInfo

/** How long a foreground change must hold before the prototype hides or comes back (#10261). */
const val PROTOTYPE_FOREGROUND_DEBOUNCE_MILLIS = 400L

/**
 * Packages whose application windows are transient system surfaces, never "the app the prototype
 * was shown over": System UI (shade, recents, volume, screenshot preview), the permission and
 * package installer dialogs, and the framework's own `android` package (resolver, ANR and crash
 * dialogs). Input methods and non-application windows are excluded by window type, not by this
 * list.
 */
internal val PROTOTYPE_FOREGROUND_IGNORED_PACKAGES: Set<String> =
  setOf(
    "com.android.systemui",
    "com.google.android.permissioncontroller",
    "com.android.permissioncontroller",
    "com.google.android.packageinstaller",
    "com.android.packageinstaller",
    "android",
  )

/**
 * The package a window event says is in front, or null when the event must not move the foreground:
 * only application-type windows count (so the IME, dialogs of type system, accessibility overlays
 * such as this prototype's own windows, and the shade are skipped), minus [ownPackage] and
 * [PROTOTYPE_FOREGROUND_IGNORED_PACKAGES]. A dialog of the same app is an application window of the
 * same package, so it never changes the answer.
 */
internal fun prototypeForegroundCandidate(
  packageName: String?,
  windowType: Int?,
  ownPackage: String,
): String? {
  if (packageName.isNullOrEmpty() || packageName == ownPackage) return null
  if (windowType != AccessibilityWindowInfo.TYPE_APPLICATION) return null
  if (packageName in PROTOTYPE_FOREGROUND_IGNORED_PACKAGES) return null
  return packageName
}

/** The facts about one accessibility window that decide whether it is the foreground app. */
internal data class PrototypeForegroundWindow(
  val type: Int,
  val active: Boolean,
  val packageName: String?,
)

/**
 * The foreground app among [windows] (z-ordered, topmost first): the active application window if
 * it qualifies, otherwise the topmost qualifying one. Null when no application window qualifies, in
 * which case the prototype is not scoped to any app.
 */
internal fun prototypeForegroundFromWindows(
  windows: List<PrototypeForegroundWindow>,
  ownPackage: String,
): String? {
  val candidates = windows.mapNotNull { window ->
    prototypeForegroundCandidate(window.packageName, window.type, ownPackage)?.let {
      it to window.active
    }
  }
  return (candidates.firstOrNull { it.second } ?: candidates.firstOrNull())?.first
}

/** What [PrototypeController] needs from foreground scoping. */
interface PrototypeForegroundScope {
  /** True while the prototype's app is not in front; the window is hidden and untouchable. */
  val suspended: Boolean

  /** A show: tie the prototype to the app now in front and clear any suspension. */
  fun anchor()

  /** The prototype ended (or is not app-scoped): forget the anchor and any suspension. */
  fun release()

  /** The anchor and suspension now, so a show the host rejects can put them back. */
  fun capture(): PrototypeForegroundState = PrototypeForegroundState(null, false)

  /** Put back what [capture] returned: a rejected show keeps the previous window's scoping. */
  fun restore(state: PrototypeForegroundState) = Unit
}

/** An opaque snapshot of foreground scoping taken by [PrototypeForegroundScope.capture]. */
data class PrototypeForegroundState(val anchor: String?, val suspended: Boolean)

object NoPrototypeForegroundScope : PrototypeForegroundScope {
  override val suspended = false

  override fun anchor() = Unit

  override fun release() = Unit
}

/**
 * Tracks the foreground application from window events and suspends an anchored prototype while
 * another app is in front. Suspension is its own state: it is not the lock-screen block and not a
 * capture-time hide, so ending one never re-shows the prototype for another. [onChanged] runs after
 * a debounced flip so the controller can hide or restore the window.
 *
 * Thread-safe: events arrive on the service thread, the debounce fires on the scheduler.
 */
class PrototypeForegroundTracker(
  private val scheduler: PrototypeScheduler,
  private val ownPackage: String,
  private val debounceMillis: Long = PROTOTYPE_FOREGROUND_DEBOUNCE_MILLIS,
  /** The application package in front right now, read when a prototype is shown. */
  private val foregroundNow: () -> String? = { null },
  private val onChanged: suspend () -> Unit = {},
) : PrototypeForegroundScope {
  private val lock = Any()
  private var anchor: String? = null
  private var pendingTarget: Boolean? = null
  private var pending: PrototypeScheduledTask? = null

  @Volatile
  override var suspended = false
    private set

  override fun anchor() {
    synchronized(lock) {
      cancelPending()
      anchor = foregroundNow()
      suspended = false
    }
  }

  override fun release() {
    synchronized(lock) {
      cancelPending()
      anchor = null
      suspended = false
    }
  }

  override fun capture(): PrototypeForegroundState =
    synchronized(lock) { PrototypeForegroundState(anchor, suspended) }

  override fun restore(state: PrototypeForegroundState) {
    synchronized(lock) {
      cancelPending()
      anchor = state.anchor
      suspended = state.suspended
    }
  }

  /** Feed every window-state/windows-changed event with its package and window type. */
  fun onWindowEvent(packageName: String?, windowType: Int?) {
    val candidate = prototypeForegroundCandidate(packageName, windowType, ownPackage) ?: return
    synchronized(lock) {
      val scoped = anchor ?: return
      val want = candidate != scoped
      if (want == (pendingTarget ?: suspended)) return
      cancelPending()
      if (want == suspended) return
      pendingTarget = want
      pending =
        scheduler.schedule(debounceMillis) {
          val flipped =
            synchronized(lock) {
              if (pendingTarget != want) return@synchronized false
              pendingTarget = null
              pending = null
              suspended = want
              true
            }
          if (flipped) onChanged()
        }
    }
  }

  private fun cancelPending() {
    pending?.cancel()
    pending = null
    pendingTarget = null
  }
}
