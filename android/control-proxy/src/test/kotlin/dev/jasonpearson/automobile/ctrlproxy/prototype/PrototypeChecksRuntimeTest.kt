package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeCheck
import dev.jasonpearson.automobile.protocol.PrototypeColumnNode
import dev.jasonpearson.automobile.protocol.PrototypeCondition
import dev.jasonpearson.automobile.protocol.PrototypeEmitAction
import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSetStateAction
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStateWriteValidator
import dev.jasonpearson.automobile.protocol.PrototypeTextFieldNode
import dev.jasonpearson.automobile.protocol.PrototypeValidateOn
import dev.jasonpearson.automobile.protocol.PrototypeValidityKeys
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class PrototypeChecksRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmChecks() {
      PrototypeSpecValidator.validate("{}")
      val runtime = PrototypeChecksRuntimeTest().runtime()
      runtime.renderModel()
      runTest { runtime.handle(PrototypeInteraction.Tap(emptyList())) }
      prototypeValidity(
        listOf(
          PrototypeTextFieldNode(
            stateKey = "x",
            checks = listOf(PrototypeCheck.Required("Required")),
          )
        ),
        mapOf("x" to PrototypeScalar.Text("")),
      )
    }
  }

  private val events = mutableListOf<PrototypeEvent>()
  private var sequence = 0L
  private val fields =
    listOf(
      PrototypeTextFieldNode(
        stateKey = "change",
        checks = listOf(PrototypeCheck.Required("Required")),
        validateOn = PrototypeValidateOn.CHANGE,
      ),
      PrototypeTextFieldNode(
        stateKey = "blur",
        checks = listOf(PrototypeCheck.Required("Required")),
      ),
      PrototypeTextFieldNode(
        stateKey = "submit",
        checks = listOf(PrototypeCheck.Required("Required")),
        validateOn = PrototypeValidateOn.SUBMIT,
      ),
    )
  private val condition =
    PrototypeCondition(valid = PrototypeValidityKeys.Multiple(listOf("change", "blur", "submit")))
  private val spec =
    PrototypeSpec(
      "checks",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      fields.associate { it.stateKey to PrototypeScalar.Text("") },
      PrototypeColumnNode(
        children = fields + PrototypeButtonNode(label = "Send", enabledWhen = condition)
      ),
    )

  private fun runtime() =
    PrototypeRuntime(spec, PrototypeEventSink { events += it }, { 42L }, { ++sequence }).also {
      // Checks are independent of write-schema validation; keep these tests device-free and fast.
      it.prepareStateWrites = { PrototypeStateWriteValidator { null } }
    }

  @Test
  fun `disabled control skips its entire interaction against current state`() = runTest {
    val runtime = runtime()
    val tap =
      PrototypeInteraction.Guarded(
        "root.children[3]",
        PrototypeInteraction.Tap(
          listOf(
            PrototypeSetStateAction("change", PrototypeScalar.Text("written")),
            PrototypeEmitAction("sent"),
          )
        ),
      )
    runtime.handle(tap)
    assertEquals(spec.state, runtime.current.state)
    assertTrue(events.isEmpty())
    for (field in fields) runtime.handle(PrototypeInteraction.TextChange(field.stateKey, "ok"))
    events.clear()
    runtime.handle(tap)
    assertEquals(PrototypeScalar.Text("written"), runtime.current.state["change"])
    assertEquals("sent", events.first().name)
  }

  @Test
  fun `disabled input skips own write and onTap`() = runTest {
    val disabled = spec.copy(root = fields.first().copy(enabledWhen = condition))
    val runtime =
      PrototypeRuntime(disabled, PrototypeEventSink { events += it }, { 42L }, { ++sequence })
    runtime.handle(
      PrototypeInteraction.Guarded("root", PrototypeInteraction.TextChange("change", "ignored"))
    )
    assertEquals(disabled.state, runtime.current.state)
    assertTrue(events.isEmpty())
  }

  @Test
  fun `failed guard aborts earlier writes and emits and shows every listed key`() = runTest {
    val runtime = runtime()
    val actions: List<PrototypeAction> =
      listOf(
        PrototypeEmitAction("earlier"),
        PrototypeSetStateAction("change", PrototypeScalar.Text("would pass")),
        PrototypeEmitAction("send", requireValid = fields.map { it.stateKey }),
        PrototypeSetStateAction("blur", PrototypeScalar.Text("later")),
      )
    runtime.handle(PrototypeInteraction.Tap(actions))
    assertEquals(spec.state, runtime.current.state)
    assertEquals(fields.map { it.stateKey }.toSet(), runtime.current.shownErrors)
    val event = events.single()
    assertEquals(PrototypeEventKind.VALIDATION_FAILED, event.kind)
    assertEquals("send", event.name)
    assertEquals(fields.map { it.stateKey }, event.keys)
    assertEquals(42L, event.timestamp)
    assertEquals(1L, event.sequence)
    assertNull(event.validity)
    assertTrue(runtime.renderModel().root.children.take(3).all { it.errorMessage == "Required" })
  }

  @Test
  fun `only failing keys are named and successful guard emits normally`() = runTest {
    val runtime = runtime()
    runtime.handle(PrototypeInteraction.TextChange("change", "ok"))
    events.clear()
    val emit =
      PrototypeInteraction.Tap(
        listOf(PrototypeEmitAction("send", requireValid = listOf("change", "blur")))
      )
    runtime.handle(emit)
    assertEquals(listOf("blur"), events.single().keys)
    assertTrue("change" in runtime.current.shownErrors)
    runtime.handle(PrototypeInteraction.TextChange("blur", "ok"))
    events.clear()
    runtime.handle(emit)
    assertEquals(PrototypeEventKind.EMIT, events.single().kind)
  }

  @Test
  fun `change blur and submit reveal errors at their own boundary`() = runTest {
    val runtime = runtime()
    assertTrue(runtime.current.shownErrors.isEmpty())
    for (field in fields) {
      runtime.handle(PrototypeInteraction.TextChange(field.stateKey, "ok"))
      runtime.handle(PrototypeInteraction.TextChange(field.stateKey, ""))
    }
    assertEquals(setOf("change"), runtime.current.shownErrors)
    runtime.handle(PrototypeInteraction.Blur(fields.map { it.stateKey }))
    assertEquals(setOf("change", "blur"), runtime.current.shownErrors)
    assertNull(runtime.renderModel().root.children[2].errorMessage)
    runtime.handle(
      PrototypeInteraction.Tap(listOf(PrototypeEmitAction("send", requireValid = listOf("submit"))))
    )
    assertEquals("Required", runtime.renderModel().root.children[2].errorMessage)
    runtime.handle(PrototypeInteraction.TextChange("submit", "ok"))
    assertNull(runtime.renderModel().root.children[2].errorMessage)
    runtime.replace(spec)
    assertTrue(runtime.current.shownErrors.isEmpty())
    assertTrue(runtime.renderModel().root.children.take(3).all { it.errorMessage == null })
  }

  @Test
  fun `change events carry all checked validity and conditions follow live values`() = runTest {
    val runtime = runtime()
    runtime.handle(PrototypeInteraction.TextChange("change", "ok"))
    assertEquals(
      mapOf("change" to true, "blur" to false, "submit" to false),
      events.single().validity,
    )
    assertFalse(runtime.renderModel().root.children.last().enabled)
    for (key in listOf("blur", "submit")) runtime.handle(PrototypeInteraction.TextChange(key, "ok"))
    assertTrue(runtime.renderModel().root.children.last().enabled)
    runtime.handle(PrototypeInteraction.TextChange("change", ""))
    assertFalse(runtime.renderModel().root.children.last().enabled)
  }

  @Test
  fun `change event omits validity when no checks exist`() = runTest {
    val runtime =
      PrototypeRuntime(
        spec.copy(root = fields.first().copy(checks = null)),
        PrototypeEventSink { events += it },
        { 42L },
        { ++sequence },
      )
    runtime.prepareStateWrites = { PrototypeStateWriteValidator { null } }
    runtime.handle(PrototypeInteraction.TextChange("change", "ok"))
    assertNull(events.single().validity)
  }
}
