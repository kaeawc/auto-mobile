package dev.jasonpearson.automobile.ctrlproxy

import android.os.Handler
import android.os.Looper
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowAccessibilityService
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.util.ReflectionHelpers

/**
 * Shared by the display-routing and caret-clearing tests; every gesture component remains the real
 * service's.
 */
@OptIn(ExperimentalCoroutinesApi::class)
internal class CtrlProxyGestureServiceFixture {
  data class Ack(val id: String?, val success: Boolean, val error: String?)

  private class InlineGestureThread : GestureThread {
    override val handler = Handler(Looper.getMainLooper())

    override fun post(work: () -> Unit): Boolean {
      work()
      return true
    }

    override fun quitSafely() = Unit
  }

  private val controller = Robolectric.buildService(CtrlProxy::class.java)
  val service: CtrlProxy = controller.get()
  val actions: CtrlProxyActions = service
  val gestureController: GestureController =
    ReflectionHelpers.getField(service, "gestureController")
  val shadow: ShadowAccessibilityService
  val acks = mutableListOf<Ack>()

  init {
    service.gestureThreadFactory = { InlineGestureThread() }
    gestureController.dragDeadline = FakeGestureDeadline()
    // Only request-result broadcasts use this scope in these tests. Run them inline, with no IO
    // worker or real timer; do not connect the service (which would open sockets/start logcat).
    ReflectionHelpers.getField<CoroutineScope>(service, "serviceScope").cancel()
    ReflectionHelpers.setField(
      service,
      "serviceScope",
      CoroutineScope(UnconfinedTestDispatcher() + SupervisorJob()),
    )
    val router =
      ReflectionHelpers.getField<GestureStreamRouter>(gestureController, "gestureStreamRouter")
    val onResult: (String?, Boolean, String?) -> Unit = { id, success, error ->
      acks.add(Ack(id, success, error))
    }
    ReflectionHelpers.setField(router, "onResult", onResult)
    controller.create()
    shadow = shadowOf(service)
    shadow.setCanDispatchGestures(true)
  }

  fun usePerfProvider(perf: PerfProvider) {
    ReflectionHelpers.setField(gestureController, "perfProvider", perf)
  }

  fun freshFrameContext(): String =
    ReflectionHelpers.callInstanceMethod(service, "currentFrameContext")

  fun seedCaret(): Any {
    // The field's erased type is Pair. These gesture paths only clear it, never read its contents;
    // an identity sentinel avoids constructing the controller's private remembered-caret types.
    val sentinel = Unit to Unit
    ReflectionHelpers.setField(textInputController(), "rememberedInsert", sentinel)
    return sentinel
  }

  fun rememberedCaret(): Any? =
    ReflectionHelpers.getField(textInputController(), "rememberedInsert")

  private fun textInputController(): TextInputController =
    ReflectionHelpers.getField(service, "textInputController")

  fun completeLastStroke() {
    val dispatch = shadow.gesturesDispatched.last()
    // Moving and final strokes complete after their planned duration in routing tests.
    ShadowSystemClock.advanceBy(Duration.ofMillis(dispatch.description().getStroke(0).duration))
    dispatch.callback().onCompleted(dispatch.description())
  }

  fun advanceDragWait() {
    val timer = gestureController.dragDeadline as FakeGestureDeadline
    ShadowSystemClock.advanceBy(Duration.ofMillis(timer.tasks.last().delayMs))
    timer.expire()
  }

  fun cancelLastStroke() {
    val dispatch = shadow.gesturesDispatched.last()
    // Tap completion extracts hierarchy after quiescence. Cancellation exercises the real callback
    // lifecycle without introducing that unrelated settling wait into these dispatch tests.
    dispatch.callback().onCancelled(dispatch.description())
  }

  fun close() {
    controller.destroy()
  }
}
