package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/** `{object}` data-action values (#18826) on the Compose runtime. */
class PrototypeObjectDataValueRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<PrototypeEvent>()
  private val warnings = mutableListOf<String>()
  private var sequence = 0L

  private fun spec() =
    (PrototypeSpecValidator.validate(
        """{"id":"todo","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["secureStorage"]},"state":{"draft":"Buy milk","token":"secret"},"storage":{"version":1,"keys":["state:draft"],"secure":["state:token"]},"data":{"todos":[]},"root":{"type":"text","text":"Todos"}}""",
      ) as PrototypeSpecValidation.Success)
      .spec

  private fun append(value: String) =
    PrototypeAppendDataAction("/data/todos", Json.parseToJsonElement(value).jsonObject)

  @Test
  fun `an object value appends a row built from state and literals`() = runTest {
    val runtime =
      PrototypeRuntime(
        spec(),
        PrototypeEventSink { events += it },
        { 1000L },
        { ++sequence },
        warn = { warnings += it },
      )
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(append("""{"object":{"title":{"state":"draft"},"done":{"value":false}}}""")),
      ),
    )
    assertEquals(
      Json.parseToJsonElement("""[{"title":"Buy milk","done":false}]"""),
      runtime.current.spec.data?.get("todos"),
    )
    assertEquals(1, events.size)
    runtime.close()
  }

  @Test
  fun `an object value with a secure member or a missing source writes nothing`() = runTest {
    val runtime =
      PrototypeRuntime(
        spec(),
        PrototypeEventSink { events += it },
        { 1000L },
        { ++sequence },
        warn = { warnings += it },
      )
    for (value in
      listOf(
        """{"object":{"title":{"state":"draft"},"secret":{"state":"token"}}}""",
        """{"object":{"title":{"state":"missing"}}}""",
        """{"object":{"title":{"data":"/nope"}}}""",
      )) {
      runtime.handle(PrototypeInteraction.Tap(listOf(append(value))))
    }
    assertEquals(JsonArray(emptyList()), runtime.current.spec.data?.get("todos"))
    assertTrue(events.isEmpty())
    assertEquals(3, warnings.size)
    runtime.close()
  }
}
