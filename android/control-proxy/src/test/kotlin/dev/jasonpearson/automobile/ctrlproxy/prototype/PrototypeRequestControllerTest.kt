package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A `request` through the real [PrototypeController] (#12528): the controller wires the transports
 * and its own lock into the runtime, applies a response between interactions, and ends the request
 * with its prototype.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeRequestControllerTest {
  private val events = mutableListOf<PrototypeEvent>()
  private val requests = mutableListOf<PrototypeHttpRequest>()
  private val answers = mutableListOf<CompletableDeferred<PrototypeRequestResponse>>()
  private val cancelled = mutableListOf<String>()

  private val transport = PrototypeHttpClient { request ->
    val answer = CompletableDeferred<PrototypeRequestResponse>()
    requests += request
    answers += answer
    try {
      answer.await()
    } catch (error: kotlinx.coroutines.CancellationException) {
      cancelled += request.requestId
      throw error
    }
  }

  private val spec: PrototypeSpec =
    PrototypeSpecValidator.validate(
        """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"state":{"status":"idle"},"data":{"title":"T"},""" +
          """"root":{"type":"button","label":"Go","onTap":[{"type":"request","url":"http://h.test/feed","into":"/data/feed","statusKey":"status","via":"device"}]}}""",
      )
      .let { (it as PrototypeSpecValidation.Success).spec }

  private fun TestScope.controller() =
    PrototypeController(
      FakePrototypeHost(),
      PrototypeResultSink { _, _, _ -> },
      eventSink = PrototypeEventSink { events += it },
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      render = { mapPrototypeSpec(it).request() },
      httpClients = PrototypeHttpClients(transport, transport),
      requestScope = backgroundScope,
    )

  private fun PrototypeRuntime.tap() =
    PrototypeInteraction.Tap(checkNotNull(renderModel().root.source?.onTap))

  @Test
  fun `a response lands between interactions and moves the status key`() = runTest {
    val controller = controller()
    controller.show("show", spec)
    val runtime = checkNotNull(controller.activeRuntime)

    controller.interact(runtime, runtime.tap())
    runCurrent()
    assertEquals("loading", (runtime.current.state["status"] as PrototypeScalar.Text).value)
    assertEquals("http://h.test/feed", requests.single().url)

    answers
      .single()
      .complete(
        PrototypeRequestResponse.Received(
          200,
          emptyMap(),
          JsonObject(mapOf("n" to JsonPrimitive(1))),
          5,
        ),
      )
    runCurrent()

    assertEquals("success", (runtime.current.state["status"] as PrototypeScalar.Text).value)
    assertEquals(
      JsonObject(mapOf("n" to JsonPrimitive(1))),
      runtime.current.spec.data!!["feed"]!!.jsonObject,
    )
    assertTrue(events.any { it.kind == PrototypeEventKind.EMIT && it.name == "prototype_request" })
  }

  @Test
  fun `dismissing the prototype cancels its request and drops the late answer`() = runTest {
    val controller = controller()
    controller.show("show", spec)
    val runtime = checkNotNull(controller.activeRuntime)
    controller.interact(runtime, runtime.tap())
    runCurrent()

    controller.dismiss("dismiss", "panel", false)
    runCurrent()

    assertEquals(listOf(requests.single().requestId), cancelled)
    assertFalse(runtime.current.active)
    assertTrue(events.none { it.name == "prototype_request" })
  }
}
