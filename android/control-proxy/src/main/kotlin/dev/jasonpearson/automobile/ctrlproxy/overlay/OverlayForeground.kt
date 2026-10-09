package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.view.accessibility.AccessibilityWindowInfo

/** How long a foreground change must hold before the overlay hides or comes back (#10261). */
const val OVERLAY_FOREGROUND_DEBOUNCE_MILLIS = 400L

/**
 * Packages whose application windows are transient system surfaces, never "the app the overlay was
 * shown over": System UI (shade, recents, volume, screenshot preview), the permission and package
 * installer dialogs, and the framework's own `android` package (resolver, ANR and crash dialogs).
 * Input methods and non-application windows are excluded by window type, not by this list.
 */
internal val OVERLAY_FOREGROUND_IGNORED_PACKAGES: Set<String> =
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
 * such as this overlay's own windows, and the shade are skipped), minus [ownPackage] and
 * [OVERLAY_FOREGROUND_IGNORED_PACKAGES]. A dialog of the same app is an application window of the
 * same package, so it never changes the answer.
 */
internal fun overlayForegroundCandidate(
  packageName: String?,
  windowType: Int?,
  ownPackage: String,
): String? {
  if (packageName.isNullOrEmpty() || packageName == ownPackage) return null
  if (windowType != AccessibilityWindowInfo.TYPE_APPLICATION) return null
  if (packageName in OVERLAY_FOREGROUND_IGNORED_PACKAGES) return null
  return packageName
}

/** The facts about one accessibility window that decide whether it is the foreground app. */
internal data class OverlayForegroundWindow(
  val type: Int,
  val active: Boolean,
  val packageName: String?,
)

/**
 * The foreground app among [windows] (z-ordered, topmost first): the active application window if
 * it qualifies, otherwise the topmost qualifying one. Null when no application window qualifies, in
 * which case the overlay is not scoped to any app.
 */
internal fun overlayForegroundFromWindows(
  windows: List<OverlayForegroundWindow>,
  ownPackage: String,
): String? {
  val candidates = windows.mapNotNull { window ->
    overlayForegroundCandidate(window.packageName, window.type, ownPackage)?.let {
      it to window.active
    }
  }
  return (candidates.firstOrNull { it.second } ?: candidates.firstOrNull())?.first
}

/** What [OverlayController] needs from foreground scoping. */
interface OverlayForegroundScope {
  /** True while the overlay's app is not in front; the window is hidden and untouchable. */
  val suspended: Boolean

  /** A show: tie the overlay to the app now in front and clear any suspension. */
  fun anchor()

  /** The overlay ended (or is not app-scoped): forget the anchor and any suspension. */
  fun release()
}

object NoOverlayForegroundScope : OverlayForegroundScope {
  override val suspended = false

  override fun anchor() = Unit

  override fun release() = Unit
}

/**
 * Tracks the foreground application from window events and suspends an anchored overlay while
 * another app is in front. Suspension is its own state: it is not the lock-screen block and not a
 * capture-time hide, so ending one never re-shows the overlay for another. [onChanged] runs after a
 * debounced flip so the controller can hide or restore the window.
 *
 * Thread-safe: events arrive on the service thread, the debounce fires on the scheduler.
 */
class OverlayForegroundTracker(
  private val scheduler: OverlayScheduler,
  private val ownPackage: String,
  private val debounceMillis: Long = OVERLAY_FOREGROUND_DEBOUNCE_MILLIS,
  /** The application package in front right now, read when an overlay is shown. */
  private val foregroundNow: () -> String? = { null },
  private val onChanged: suspend () -> Unit = {},
) : OverlayForegroundScope {
  private val lock = Any()
  private var anchor: String? = null
  private var pendingTarget: Boolean? = null
  private var pending: OverlayScheduledTask? = null

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

  /** Feed every window-state/windows-changed event with its package and window type. */
  fun onWindowEvent(packageName: String?, windowType: Int?) {
    val candidate = overlayForegroundCandidate(packageName, windowType, ownPackage) ?: return
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
