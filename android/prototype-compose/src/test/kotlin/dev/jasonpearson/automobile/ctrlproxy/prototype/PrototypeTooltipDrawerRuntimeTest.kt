package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class PrototypeTooltipDrawerRuntimeTest {
  private val condition = PrototypeSheetCondition("open", true)

  private fun runtime(node: PrototypeNode) =
    PrototypeRuntime(
      PrototypeSpec(
        "overlays",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        mapOf("open" to PrototypeScalar.BooleanValue(true)),
        node,
      ),
      nextSequence = { 1L },
    )

  @Test
  fun dismissalWritesBeforeRunningActions() = runBlocking {
    val node = PrototypeTooltipNode(text = "Hint", anchorTo = "target", openWhen = condition)
    val runtime =
      runtime(
        PrototypeColumnNode(
          children = listOf(PrototypeTextNode(id = "target", text = "Target"), node),
        ),
      )
    runtime.handle(
      PrototypeInteraction.CloseModal(condition, listOf(PrototypeToggleAction("open"))),
    )
    // Closing writes false first; the subsequent toggle sees false and turns it back on.
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["open"])
    runtime.close()
  }

  @Test
  fun drawerTakesBackBeforeStackPop() = runBlocking {
    val nav =
      PrototypeStackNode(
        id = "nav",
        start = "home",
        screens =
          mapOf(
            "home" to PrototypeTextNode(text = "Home"),
            "detail" to PrototypeTextNode(text = "Detail"),
          ),
      )
    val drawer =
      PrototypeDrawerNode(
        edge = "start",
        openWhen = condition,
        child = PrototypeTextNode(text = "Navigation"),
      )
    val runtime = runtime(PrototypeColumnNode(children = listOf(nav, drawer)))
    runtime.handle(PrototypeInteraction.Tap(listOf(PrototypePushAction("nav", "detail"))))
    assertTrue(runtime.hasPoppableStack())
    runtime.handle(PrototypeInteraction.Back)
    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["open"])
    assertEquals(listOf("home", "detail"), runtime.current.stacks.getValue("nav").path)
    assertTrue(runtime.current.active)
    runtime.handle(PrototypeInteraction.Back)
    assertEquals(listOf("home"), runtime.current.stacks.getValue("nav").path)
    runtime.close()
  }

  @Test
  fun openDrawerMakesWindowFocusableWithoutStack() {
    val runtime =
      runtime(
        PrototypeDrawerNode(
          edge = "end",
          openWhen = condition,
          child = PrototypeTextNode(text = "Navigation"),
        ),
      )
    assertTrue(runtime.hasPoppableStack())
    runtime.close()
  }

  @Test
  fun tooltipIsHoistedInsteadOfBeingAnAnchoredPageChild() {
    val tooltip =
      PrototypeTooltipNode(
        text = "Hint",
        anchor = PrototypeBoundsAnchor(PrototypeBounds(10.0, 20.0, 40.0, 40.0)),
        openWhen = condition,
      )
    val runtime = runtime(PrototypeColumnNode(children = listOf(tooltip)))
    val root = runtime.renderModel().root
    assertEquals(listOf("tooltip"), modalPrototypeSheets(root).map { it.role })
    assertTrue(layeredPrototypeAnchors(root).isEmpty())
    runtime.close()
  }
}
