package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.BeforeClass
import org.junit.Test

/**
 * A `request` response writes `into` and `statusKey` outside any tap (#12528), so a stored key it
 * changes must still be persisted (#12522). A fake client answers when the test says so.
 */
class PrototypeRequestStorageTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }

    private const val SPEC =
      """{"id":"feed","window":{"placement":{"type":"fullscreen"}},"state":{"status":"idle"},""" +
        """"data":{"feed":[]},"storage":{"version":1,"keys":["state:status","data:/feed"]},""" +
        """"root":{"type":"column","children":[{"type":"button","label":"Go","onTap":[""" +
        """{"type":"request","url":"http://localhost:8080/feed","into":"/data/feed","statusKey":"status"}]}]}}"""
  }

  private class FakeHttp : PrototypeHttpClient {
    val answer = CompletableDeferred<PrototypeRequestResponse>()

    override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse =
      answer.await()
  }

  private val store = FakePrototypeStorageStore()
  private val timer = FakePrototypeTimer()
  private val http = FakeHttp()
  private val events = mutableListOf<PrototypeEvent>()
  private var sequence = 0L

  private fun spec(): PrototypeSpec {
    val validation = PrototypeSpecValidator.validate(SPEC)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  private suspend fun TestScope.runtime(): PrototypeRuntime {
    val opened =
      PrototypeStoragePersistence(
          store,
          timer,
          EmptyCoroutineContext,
          warn = PrototypeStorageWarn { _, _ -> },
        )
        .open(spec())
    return PrototypeRuntime(
      opened.spec,
      PrototypeEventSink { events += it },
      { 42L },
      { ++sequence },
      httpClients = PrototypeHttpClients(http, http),
      requestScope = backgroundScope,
      storage = opened.session,
    )
  }

  @Test
  fun `a response that writes a stored key is persisted`() = runTest {
    val runtime = runtime()
    runtime.handle(
      PrototypeInteraction.Tap(checkNotNull(runtime.renderModel().root.children[0].source?.onTap)),
    )
    runCurrent()
    http.answer.complete(
      PrototypeRequestResponse.Received(
        200,
        emptyMap(),
        Json.parseToJsonElement("""["a","b"]"""),
        3,
      ),
    )
    runCurrent()
    timer.advance(PROTOTYPE_STORAGE_DEBOUNCE_MILLIS)

    val saved = checkNotNull(store.stored("feed"))
    assertEquals(Json.parseToJsonElement("""["a","b"]"""), saved.values["data:/feed"])
    assertEquals(JsonPrimitive("success"), saved.values["state:status"])
  }
}
