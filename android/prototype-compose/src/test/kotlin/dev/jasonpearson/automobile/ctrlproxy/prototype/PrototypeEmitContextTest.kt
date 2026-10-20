package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeEmitContextTest {
  @Test
  fun repeatRowThreeReadsPrecedingWriteAndKeepsNumericId() = runTest {
    val context =
      linkedMapOf(
        "orderId" to JsonObject(mapOf("item" to JsonPrimitive("id"))),
        "row" to JsonObject(mapOf("index" to JsonPrimitive(true))),
        "selected" to JsonObject(mapOf("state" to JsonPrimitive("selected_{item.id}"))),
      )
    val root =
      PrototypeColumnNode(
        repeat =
          PrototypeRepeat(
            items = (1..3).map { mapOf("id" to PrototypeScalar.Numeric(it.toDouble())) },
            `as` = "item",
          ),
        children =
          listOf(
            PrototypeTextNode(
              text = "pick",
              onTap =
                listOf(
                  PrototypeSetStateAction("selected_{item.id}", PrototypeScalar.BooleanValue(true)),
                  PrototypeEmitAction("pick", context = context),
                ),
            ),
          ),
      )
    val events = mutableListOf<PrototypeEvent>()
    var sequence = 0L
    val runtime =
      PrototypeRuntime(
        PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), root = root),
        PrototypeEventSink { events += it },
        { 42L },
        { ++sequence },
      )
    // Fake the state-write gate; protocol fixture tests exercise the real shared validator.
    runtime.prepareStateWrites = { PrototypeStateWriteValidator { null } }
    val row = prototypeChildEntries(root, "root")[2].node as PrototypeTextNode
    runtime.handle(PrototypeInteraction.Tap(checkNotNull(row.onTap)))
    val emitted = events.first { it.name == "pick" }
    assertEquals(JsonPrimitive(3), emitted.context?.get("orderId"))
    assertEquals(JsonPrimitive(2), emitted.context?.get("row"))
    assertEquals(JsonPrimitive(true), emitted.context?.get("selected"))
    assertNull(emitted.contextTruncated)
  }

  @Test
  fun overBudgetEventRetainsPrefixAndMarksTruncation() = runTest {
    val events = mutableListOf<PrototypeEvent>()
    val runtime =
      PrototypeRuntime(
        PrototypeSpec(
          "panel",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          root = PrototypeTextNode(text = "pick"),
        ),
        PrototypeEventSink { events += it },
        { 42L },
        { 1L },
      )
    val bindings =
      linkedMapOf(
        "first" to JsonObject(mapOf("value" to JsonPrimitive(3))),
        "large" to JsonObject(mapOf("value" to JsonPrimitive("x".repeat(4096)))),
        "last" to JsonObject(mapOf("value" to JsonPrimitive(true))),
      )
    runtime.handle(
      PrototypeInteraction.Tap(listOf(PrototypeEmitAction("pick", context = bindings))),
    )
    assertEquals(JsonObject(mapOf("first" to JsonPrimitive(3))), events.single().context)
    assertEquals(true, events.single().contextTruncated)
  }

  @Test
  fun rejectedLaterWritePreventsContextEmission() = runTest {
    val events = mutableListOf<PrototypeEvent>()
    val runtime =
      PrototypeRuntime(
        PrototypeSpec(
          "panel",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          root = PrototypeTextNode(text = "pick"),
        ),
        PrototypeEventSink { events += it },
        { 42L },
        { 1L },
      )
    runtime.prepareStateWrites = {
      PrototypeStateWriteValidator { PrototypeSpecError("state", "rejected") }
    }
    val actions =
      listOf(
        PrototypeEmitAction("pick", context = emptyMap()),
        PrototypeSetStateAction("key", PrototypeScalar.Text("new")),
      )
    try {
      runtime.handle(PrototypeInteraction.Tap(actions))
      fail("Expected write rejection")
    } catch (expected: IllegalArgumentException) {
      assertTrue(expected.message.orEmpty().contains("rejected"))
    }
    assertTrue(events.isEmpty())
    assertTrue(runtime.current.state.isEmpty())
  }

  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
      EmitContextResolver.scalar(PrototypeScalar.Numeric(3.0))
      runTest {
        val runtime =
          PrototypeRuntime(
            PrototypeSpec(
              "warm",
              PrototypeWindow(PrototypeFullscreenPlacement()),
              root = PrototypeTextNode(text = "warm"),
            ),
            nextSequence = { 1L },
          )
        runtime.prepareStateWrites = { PrototypeStateWriteValidator { null } }
        runtime.handle(
          PrototypeInteraction.Tap(
            listOf(
              PrototypeSetStateAction("warm", PrototypeScalar.BooleanValue(true)),
              PrototypeEmitAction("warm", context = emptyMap()),
            ),
          ),
        )
      }
    }
  }
}
