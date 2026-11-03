package dev.jasonpearson.automobile.sdk.carapp

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.Looper
import androidx.car.app.Screen
import androidx.car.app.ScreenManager
import androidx.car.app.model.Template
import java.util.WeakHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Opt-in, read-only Car App Library template snapshots for AutoMobile `observe` (#16751).
 *
 * The Car App Library keeps the template a screen last produced private, so the app passes each
 * template through [record] as it returns it:
 * ```
 * override fun onGetTemplate(): Template =
 *   AutoMobileCarAppTemplates.record(this, ListTemplate.Builder()...build())
 * ```
 *
 * Nothing is recorded until [enable] is called from a debuggable build; until then [record] only
 * returns its argument. The snapshot walks each `ScreenManager` stack a recorded screen belongs to
 * and reports, per screen, the last template recorded for it. It reports what the template
 * contains, never what the host rendered.
 *
 * The SDK declares the Car App Library `compileOnly`, so only apps that already link it load this
 * class.
 */
object AutoMobileCarAppTemplates {
  private val recorder = CarAppTemplateRecorder(LooperMainThreadRunner)

  /**
   * Turns recording and the debug snapshot route on. Returns false, and stays off, when the app is
   * not debuggable.
   */
  @JvmStatic
  fun enable(context: Context): Boolean {
    val debuggable = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
    if (!debuggable) return false
    recorder.enabled = true
    CarAppTemplateRoute.source = recorder::snapshot
    return true
  }

  /** Turns recording off and forgets every recorded template. */
  @JvmStatic
  fun disable() {
    CarAppTemplateRoute.source = null
    recorder.enabled = false
    recorder.clear()
  }

  /** Records [template] as [screen]'s latest template and returns it unchanged. */
  @JvmStatic
  fun <T : Template> record(screen: Screen, template: T): T {
    if (recorder.enabled) recorder.record(screen, template)
    return template
  }
}

/** Runs a block on the main thread, where the Car App Library mutates its screen stacks. */
internal interface MainThreadRunner {
  fun <T> run(block: () -> T): T
}

internal object LooperMainThreadRunner : MainThreadRunner {
  private const val TIMEOUT_MS = 1_000L

  override fun <T> run(block: () -> T): T {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    val latch = CountDownLatch(1)
    var outcome: Result<T>? = null
    Handler(Looper.getMainLooper()).post {
      outcome = runCatching(block)
      latch.countDown()
    }
    check(latch.await(TIMEOUT_MS, TimeUnit.MILLISECONDS)) { MAIN_THREAD_TIMEOUT }
    return checkNotNull(outcome).getOrThrow()
  }
}

internal const val MAIN_THREAD_TIMEOUT = "main_thread_timeout"

/** Holds the recorded templates; weak keys so a finished screen or session is never retained. */
internal class CarAppTemplateRecorder(private val mainThread: MainThreadRunner) {
  @Volatile var enabled: Boolean = false

  private val lock = Any()
  private val templates = WeakHashMap<Screen, Template>()
  private val sessionIds = WeakHashMap<ScreenManager, Int>()
  private var nextSessionId = 0

  fun record(screen: Screen, template: Template) {
    // A screen's manager is fixed for its CarContext, so read it once while recording.
    val manager = screen.screenManager
    synchronized(lock) {
      templates[screen] = template
      sessionIds.getOrPut(manager) { nextSessionId++ }
    }
  }

  fun clear() {
    synchronized(lock) {
      templates.clear()
      sessionIds.clear()
    }
  }

  fun snapshot(): CarAppTemplateDocument {
    val (recorded, sessions) =
      synchronized(lock) { HashMap(templates) to sessionIds.entries.map { it.key to it.value } }
    return try {
      val walked = mainThread.run {
        sessions
          .sortedBy { it.second }
          .mapNotNull { (manager, ordinal) -> walk(manager, "session$ordinal", recorded) }
      }
      CarAppTemplateDocument(enabled = true, sessions = walked)
    } catch (error: IllegalStateException) {
      CarAppTemplateDocument(enabled = true, error = error.message ?: MAIN_THREAD_TIMEOUT)
    }
  }

  private fun walk(
    manager: ScreenManager,
    sessionId: String,
    recorded: Map<Screen, Template>,
  ): CarAppSessionSnapshot? {
    // getScreenStack iterates from the top screen down; report the root first.
    val stack = manager.screenStack.reversed()
    if (stack.isEmpty()) return null
    val top = manager.top
    val screens = stack.mapIndexed { index, screen ->
      val id = "$sessionId/screen$index"
      CarAppScreenSnapshot(
        id = id,
        screenClass = screen.javaClass.name,
        top = screen === top,
        marker = screen.marker,
        template = recorded[screen]?.let { CarAppTemplateMapper.map(it, "$id/template") },
      )
    }
    return CarAppSessionSnapshot(id = sessionId, screens = screens)
  }
}
