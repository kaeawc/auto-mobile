package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/** A tap runs `upsertData` and `setStack` like the other data and stack actions (#16620). */
class PrototypeTapUpsertSetStackTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<PrototypeEvent>()
  private var sequence = 0L

  private fun runtime(root: PrototypeNode, data: JsonObject? = null) =
    PrototypeRuntime(
      PrototypeSpec(
        "panel",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root = root,
        data = data,
      ),
      PrototypeEventSink { events += it },
      { 42L },
      { ++sequence },
      warn = {},
    )

  private fun json(text: String) = Json.parseToJsonElement(text).jsonObject

  private fun upsert(row: String) =
    PrototypeInteraction.Tap(
      listOf(PrototypeUpsertDataAction("/data/rows", json("""{"value":$row}"""), key = "/id")),
    )

  private fun setStack(vararg screens: String) =
    PrototypeInteraction.Tap(
      listOf(PrototypeSetStackAction("nav", screens.map { PrototypeRouteEntry(it) })),
    )

  private val stack =
    PrototypeStackNode(
      "nav",
      start = "home",
      screens =
        linkedMapOf(
          "home" to PrototypeTextNode(text = "Home"),
          "detail" to PrototypeTextNode(text = "Detail"),
          "third" to PrototypeTextNode(text = "Third"),
        ),
    )

  @Test
  fun `upsertData appends a new key and replaces an existing one with a change event`() = runTest {
    val runtime = runtime(PrototypeTextNode(text = "Rows"), json("""{"rows":[{"id":"a","n":1}]}"""))
    runtime.handle(upsert("""{"id":"b","n":2}"""))
    runtime.handle(upsert("""{"id":"a","n":3}"""))
    assertEquals(
      Json.parseToJsonElement("""[{"id":"a","n":3},{"id":"b","n":2}]"""),
      runtime.current.spec.data!!.getValue("rows"),
    )
    assertEquals(
      listOf(PrototypeEventKind.CHANGE, PrototypeEventKind.CHANGE),
      events.map { it.kind },
    )
    assertTrue(events.all { it.name == "/data/rows" })
    val payload = events.last().payload!!.jsonObject
    assertEquals("upsert", payload.getValue("op").jsonPrimitive.content)
    assertEquals("/id", payload.getValue("key").jsonPrimitive.content)
    assertEquals(json("""{"id":"a","n":3}"""), payload.getValue("value"))
    assertEquals(runtime.current.revision, payload.getValue("revision").jsonPrimitive.long)
  }

  @Test
  fun `upsertData on a missing array changes and emits nothing`() = runTest {
    val runtime = runtime(PrototypeTextNode(text = "Rows"), json("""{"other":1}"""))
    runtime.handle(upsert("""{"id":"b"}"""))
    assertEquals(json("""{"other":1}"""), runtime.current.spec.data)
    assertTrue(events.isEmpty())
  }

  @Test
  fun `setStack replaces the whole path and reports the new top`() = runTest {
    val runtime = runtime(stack)
    runtime.handle(setStack("home", "third", "detail"))
    assertEquals(listOf("home", "third", "detail"), runtime.current.stacks.getValue("nav").path)
    val event = events.single()
    assertEquals(PrototypeEventKind.SCREEN_CHANGED, event.kind)
    assertEquals("nav", event.name)
    assertEquals("detail", event.payload!!.jsonObject.getValue("screen").jsonPrimitive.content)
    assertEquals(3, event.payload!!.jsonObject.getValue("depth").jsonPrimitive.int)
    assertEquals(
      listOf("home", "third", "detail"),
      runtime.current.stackEdges.getValue("nav").map { it.screen },
    )
  }

  @Test
  fun `setStack with an unknown screen, an empty path or the same path is silent`() = runTest {
    val runtime = runtime(stack)
    runtime.handle(setStack("home", "missing"))
    runtime.handle(setStack())
    runtime.handle(setStack("home"))
    assertEquals(listOf("home"), runtime.current.stacks.getValue("nav").path)
    assertTrue(events.isEmpty())
  }
}
