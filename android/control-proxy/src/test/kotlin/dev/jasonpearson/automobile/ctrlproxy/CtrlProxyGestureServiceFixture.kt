package dev.jasonpearson.automobile.ctrlproxy

import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowAccessibilityService
import org.robolectric.util.ReflectionHelpers

/**
 * Shared by the dispatch and overload tests; every gesture component remains the real service's.
 */
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
  val shadow: ShadowAccessibilityService
  val acks = mutableListOf<Ack>()

  init {
    service.gestureThreadFactory = { InlineGestureThread() }
    // Only request-result broadcasts use this scope in these tests. Run them inline, with no IO
    // worker or real timer; do not connect the service (which would open sockets/start logcat).
    ReflectionHelpers.getField<CoroutineScope>(service, "serviceScope").cancel()
    ReflectionHelpers.setField(
      service,
      "serviceScope",
      CoroutineScope(Dispatchers.Unconfined + SupervisorJob()),
    )
    val router = ReflectionHelpers.getField<GestureStreamRouter>(service, "gestureStreamRouter")
    val onResult: (String?, Boolean, String?) -> Unit = { id, success, error ->
      acks.add(Ack(id, success, error))
    }
    ReflectionHelpers.setField(router, "onResult", onResult)
    controller.create()
    shadow = shadowOf(service)
    shadow.setCanDispatchGestures(true)
  }

  fun freshFrameContext(): String =
    ReflectionHelpers.callInstanceMethod(service, "currentFrameContext")

  fun seedCaret(): Any {
    // The field's erased type is Pair. These gesture paths only clear it, never read its contents;
    // an identity sentinel avoids constructing the service's private text-input implementation.
    val sentinel = Unit to Unit
    ReflectionHelpers.setField(service, "rememberedInsert", sentinel)
    return sentinel
  }

  fun rememberedCaret(): Any? = ReflectionHelpers.getField(service, "rememberedInsert")

  fun completeLastStroke() {
    val dispatch = shadow.gesturesDispatched.last()
    dispatch.callback().onCompleted(dispatch.description())
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
