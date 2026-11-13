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

/** Posts to, and cancels on, the main thread. The seam [PostedMainThreadRunner] is tested over. */
internal interface MainThreadPoster {
  fun isCurrentThread(): Boolean

  /** False when the main looper is gone and the task will never run. */
  fun post(task: Runnable): Boolean

  /** Drops [task] if it is still queued. A task already running is unaffected. */
  fun cancel(task: Runnable)
}

internal class HandlerMainThreadPoster : MainThreadPoster {
  private val handler by lazy { Handler(Looper.getMainLooper()) }

  override fun isCurrentThread(): Boolean = Looper.myLooper() == Looper.getMainLooper()

  override fun post(task: Runnable): Boolean = handler.post(task)

  override fun cancel(task: Runnable) = handler.removeCallbacks(task)
}

internal class PostedMainThreadRunner(
  private val poster: MainThreadPoster,
  private val timeoutMs: Long = MAIN_THREAD_TIMEOUT_MS,
) : MainThreadRunner {
  override fun <T> run(block: () -> T): T {
    if (poster.isCurrentThread()) return block()
    val latch = CountDownLatch(1)
    var outcome: Result<T>? = null
    val task = Runnable {
      outcome = runCatching(block)
      latch.countDown()
    }
    check(poster.post(task)) { MAIN_THREAD_UNAVAILABLE }
    if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
      // Nobody waits for this snapshot any more. Cancelling drops the task while it is still
      // queued, which is the stalled-main-thread case; one already running finishes harmlessly.
      poster.cancel(task)
      throw IllegalStateException(MAIN_THREAD_TIMEOUT)
    }
    return checkNotNull(outcome).getOrThrow()
  }
}

internal object LooperMainThreadRunner :
  MainThreadRunner by PostedMainThreadRunner(HandlerMainThreadPoster())

internal const val MAIN_THREAD_TIMEOUT = "main_thread_timeout"
internal const val MAIN_THREAD_UNAVAILABLE = "main_thread_unavailable"
internal const val MAIN_THREAD_TIMEOUT_MS = 1_000L

private const val TEMPLATE_ID = "template"

/**
 * Holds the recorded templates as callback-free nodes. A `Template` keeps its click, search and
 * toggle listeners, which usually capture their `Screen`; holding it as a weak map's value would
 * keep that key alive. The node holds only strings and flags, so a finished screen is collected.
 */
internal class CarAppTemplateRecorder(private val mainThread: MainThreadRunner) {
  @Volatile var enabled: Boolean = false

  private val lock = Any()
  private val templates = WeakHashMap<Screen, CarAppTemplateNode>()
  private val sessionIds = WeakHashMap<ScreenManager, Int>()
  private var nextSessionId = 0

  fun record(screen: Screen, template: Template) {
    // A screen's manager is fixed for its CarContext, so read it once while recording.
    val manager = screen.screenManager
    // Ids are relative here; the snapshot prefixes the screen's position in its stack.
    val node = CarAppTemplateMapper.map(template, TEMPLATE_ID)
    synchronized(lock) {
      // disable() turns recording off and clears under this lock, so a write that raced it must
      // not land afterwards.
      if (!enabled) return
      templates[screen] = node
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
    return try {
      val walked = mainThread.run {
        // Copy on the main thread, where records and stack pushes happen, so the walk cannot
        // mix the templates of one state with the stacks of another.
        val (recorded, sessions) =
          synchronized(lock) {
            HashMap(templates) to sessionIds.entries.map { it.key to it.value }
          }
        sessions
          .sortedBy { it.second }
          .mapNotNull { (manager, ordinal) ->
            walk(manager, "session$ordinal", recorded)
          }
      }
      CarAppTemplateDocument(enabled = true, sessions = walked)
    } catch (error: IllegalStateException) {
      CarAppTemplateDocument(enabled = true, error = error.message ?: MAIN_THREAD_TIMEOUT)
    }
  }

  private fun walk(
    manager: ScreenManager,
    sessionId: String,
    recorded: Map<Screen, CarAppTemplateNode>,
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
        template = recorded[screen]?.withIdPrefix("$id/"),
      )
    }
    return CarAppSessionSnapshot(id = sessionId, screens = screens)
  }
}
