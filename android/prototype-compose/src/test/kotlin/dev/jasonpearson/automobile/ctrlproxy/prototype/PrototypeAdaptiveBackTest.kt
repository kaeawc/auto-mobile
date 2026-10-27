package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.warmEmbeddedValidator
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeAdaptiveBackTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() = runBlocking {
      warmEmbeddedValidator()
      val runtime =
        PrototypeRuntime(
          PrototypeSpec(
            "warm",
            PrototypeWindow(PrototypeFullscreenPlacement()),
            mapOf("warm" to PrototypeScalar.Text("")),
            PrototypeTextNode(text = "Warm"),
          ),
          clock = { 0L },
          nextSequence = { 1L },
        )
      runtime.renderModel()
      runtime.handle(PrototypeInteraction.Choose("warm", "ready"))
      runtime.close()
    }
  }

  @Test
  fun compactBackClearsSelectionAndExpandedKeepsIt() {
    val spec =
      PrototypeSpec(
        "adaptive",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        mapOf("selected" to PrototypeScalar.Text("row")),
        PrototypeAdaptiveNode(
          kind = "listDetail",
          selectionKey = "selected",
          list = PrototypeTextNode(text = "List"),
          detail = PrototypeTextNode(text = "Detail"),
        ),
      )
    val root = mapPrototypeSpec(spec).root
    assertEquals(PrototypeInteraction.Choose("selected", ""), adaptiveBackTarget(root, false))
    assertNull(adaptiveBackTarget(root, true))
    assertNull(adaptiveBackTarget(root.copy(selectedValue = ""), false))
    assertNull(adaptiveBackTarget(root.copy(visible = false), false))
  }

  @Test
  fun overlayBackClearsSelectionWithoutDismissing() = runBlocking {
    val spec =
      PrototypeSpec(
        "adaptive",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        mapOf("selected" to PrototypeScalar.Text("row")),
        PrototypeAdaptiveNode(
          kind = "listDetail",
          selectionKey = "selected",
          list = PrototypeTextNode(text = "List"),
          detail = PrototypeTextNode(text = "Detail"),
        ),
      )
    val runtime = PrototypeRuntime(spec, clock = { 0L }, nextSequence = { 1L })
    assertTrue(runtime.hasPoppableStack())
    runtime.handle(PrototypeInteraction.Back)
    assertEquals(PrototypeScalar.Text(""), runtime.current.state["selected"])
    assertTrue(runtime.current.active)
    assertFalse(runtime.hasPoppableStack())
    runtime.close()
  }

  @Test
  fun supportingBackOnlyClosesWhenOpenAndCompact() {
    val spec =
      PrototypeSpec(
        "adaptive",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        mapOf("open" to PrototypeScalar.BooleanValue(true)),
        PrototypeAdaptiveNode(
          kind = "supporting",
          openKey = "open",
          main = PrototypeTextNode(text = "Main"),
          supporting = PrototypeTextNode(text = "Supporting"),
        ),
      )
    val root = mapPrototypeSpec(spec).root
    assertEquals(PrototypeInteraction.Toggle("open"), adaptiveBackTarget(root, false))
    assertNull(adaptiveBackTarget(root, true))
    assertNull(adaptiveBackTarget(root.copy(checked = false), false))
  }
}
