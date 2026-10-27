package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypePagerStateKeyTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private fun spec(page: Double = 0.0, count: Int = 3) =
    PrototypeSpec(
      "deck",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root =
        PrototypePagerNode(
          "deck",
          children = List(count) { PrototypeTextNode(text = "page") },
          stateKey = "page",
        ),
      state = mapOf("page" to PrototypeScalar.Numeric(page)),
    )

  @Test
  fun `swipe writes key and emits two events once with final snapshots`() = runTest {
    val events = mutableListOf<PrototypeEvent>()
    var sequence = 0L
    val runtime =
      PrototypeRuntime(
        spec(),
        PrototypeEventSink { events += it },
        { testScheduler.currentTime },
        { ++sequence },
        requestScope = backgroundScope,
      )
    runtime.handle(PrototypeInteraction.SettledPage("deck", 2))
    assertEquals(PrototypeScalar.Numeric(2.0), runtime.current.state["page"])
    assertEquals(listOf("deck", "change"), events.map { it.name })
    assertTrue(
      events.all { it.state["page"] == PrototypeScalar.Numeric(2.0) && it.pages["deck"] == 2 },
    )
    runtime.handle(PrototypeInteraction.SettledPage("deck", 2))
    assertEquals(2, events.size)
  }

  @Test
  fun `key actions clamp and replacement state wins over restored page`() = runTest {
    var sequence = 0L
    val runtime =
      PrototypeRuntime(
        spec(1.0),
        clock = { testScheduler.currentTime },
        nextSequence = { ++sequence },
        requestScope = backgroundScope,
      )
    assertEquals(1, runtime.current.pages["deck"])
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(PrototypeSetStateAction("page", PrototypeScalar.Numeric(99.0))),
      ),
    )
    assertEquals(2, runtime.current.pages["deck"])
    assertEquals(PrototypeScalar.Numeric(2.0), runtime.current.state["page"])
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(PrototypeSetStateAction("page", PrototypeScalar.Numeric(-99.0))),
      ),
    )
    assertEquals(0, runtime.current.pages["deck"])
    runtime.replace(spec(99.0, 2))
    assertEquals(1, runtime.current.pages["deck"])
    assertEquals(PrototypeScalar.Numeric(1.0), runtime.current.state["page"])
    runtime.replace(spec(0.0, 2))
    assertEquals(0, runtime.current.pages["deck"])
  }

  @Test
  fun `setPage navigation stepping and patch all share the selection`() = runTest {
    var sequence = 0L
    val runtime =
      PrototypeRuntime(
        spec(),
        clock = { testScheduler.currentTime },
        nextSequence = { ++sequence },
        requestScope = backgroundScope,
      )
    runtime.handle(PrototypeInteraction.Tap(listOf(PrototypeIncrementAction("page"))))
    assertEquals(1, runtime.current.pages["deck"])
    runtime.handle(PrototypeInteraction.Tap(listOf(PrototypeDecrementAction("page"))))
    assertEquals(0, runtime.current.pages["deck"])
    runtime.handle(PrototypeInteraction.Select(index = 2, pager = "deck", key = null))
    assertEquals(PrototypeScalar.Numeric(2.0), runtime.current.state["page"])
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(PrototypeSetPageAction("deck", PrototypePageTarget.Index(1))),
      ),
    )
    assertEquals(PrototypeScalar.Numeric(1.0), runtime.current.state["page"])
    val json = Json { classDiscriminator = "type" }
    val ops =
      json.parseToJsonElement("""[{"op":"replace","path":"/state/page","value":-99}]""").jsonArray
    val result =
      runtime.patch(runtime.current.revision, ops, json) { value ->
        (PrototypeSpecValidator.validate(value.toString()) as PrototypeSpecValidation.Success).spec
      }
    assertTrue(result is PrototypeRuntime.PatchResult.Applied)
    assertEquals(0, runtime.current.pages["deck"])
    assertEquals(PrototypeScalar.Numeric(0.0), runtime.current.state["page"])
  }
}
