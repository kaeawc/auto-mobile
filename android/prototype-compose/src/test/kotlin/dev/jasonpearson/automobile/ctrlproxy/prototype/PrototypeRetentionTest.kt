package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Test

class PrototypeRetentionTest {
  private val condition = PrototypeCondition("show", PrototypeScalar.BooleanValue(true))
  private val dpStyle =
    PrototypeStyle(width = PrototypeDimension.Dp(48.0), height = PrototypeDimension.Dp(32.0))

  private fun node(
    identity: String,
    role: String = "box",
    children: List<PrototypeRenderNode> = emptyList(),
    style: PrototypeStyle = PrototypeStyle(),
    source: PrototypeNode = PrototypeBoxNode(children = emptyList()),
  ) =
    PrototypeRenderNode(
      role,
      "",
      null,
      true,
      mapPrototypeStyle(style),
      null,
      children = children,
      source = source,
      identity = identity,
    )

  private fun candidate(identity: String, size: Int = PROTOTYPE_RETAIN_MIN_NODES) =
    node(
      identity,
      children = List(size - 1) { node("$identity.$it", role = "text") },
      source =
        PrototypeBoxNode(
          visibleWhen = condition,
          transition = PrototypeTransition("none"),
          children = emptyList(),
        ),
    )

  private fun retained(child: PrototypeRenderNode, parent: PrototypeRenderNode = node("root")) =
    prototypeRetainedSubtrees(parent.copy(children = listOf(child)))

  @Test
  fun `plain container does not animate its size`() {
    assertFalse(prototypeContainerAnimatesSize(node("plain")))
  }

  @Test
  fun `direct visibility and authored repeat own size animation`() {
    assertTrue(
      prototypeContainerAnimatesSize(node("parent", children = listOf(candidate("child")))),
    )
    val repeat = PrototypeRepeat(listOf(mapOf("label" to PrototypeScalar.Text("item"))), "item")
    val sources =
      listOf(
        PrototypeBoxNode(repeat = repeat, children = emptyList()),
        PrototypeRowNode(repeat = repeat, children = emptyList()),
        PrototypeColumnNode(repeat = repeat, children = emptyList()),
      )
    sources.forEach { assertTrue(prototypeContainerAnimatesSize(node("repeat", source = it))) }
  }

  @Test
  fun `visibility propagates through card scroll and pager but not box row or column`() {
    listOf("card", "scroll", "pager", "box", "row", "column").forEach { role ->
      val middle = node("middle", role, children = listOf(candidate("child")))
      assertEquals(
        role,
        role in setOf("card", "scroll", "pager"),
        prototypeContainerAnimatesSize(node("parent", children = listOf(middle))),
      )
    }
  }

  private fun image(style: PrototypeStyle = dpStyle) =
    node(
      "image",
      "image",
      style = style,
      source = PrototypeImageNode(asset = PrototypeModeValue.Single("hero"), style = style),
    )

  @Test
  fun `authored image size subtracts padding and clamps at zero`() {
    assertEquals(DpSize(48.dp, 32.dp), prototypeAuthoredImageSize(image()))
    assertEquals(
      DpSize(43.dp, 25.dp),
      prototypeAuthoredImageSize(
        image(
          dpStyle.copy(padding = PrototypePadding(start = 2.0, end = 3.0, top = 3.0, bottom = 4.0)),
        ),
      ),
    )
    assertEquals(
      DpSize(0.dp, 0.dp),
      prototypeAuthoredImageSize(
        image(dpStyle.copy(padding = PrototypePadding(start = 100.0, top = 100.0))),
      ),
    )
  }

  @Test
  fun `authored image size excludes every constraint dependent style`() {
    val styles =
      listOf(
        dpStyle.copy(width = PrototypeDimension.Fill),
        dpStyle.copy(height = PrototypeDimension.Fill),
        dpStyle.copy(width = PrototypeDimension.Wrap),
        dpStyle.copy(height = PrototypeDimension.Wrap),
        dpStyle.copy(width = null),
        dpStyle.copy(height = null),
        dpStyle.copy(weight = 1.0),
        dpStyle.copy(aspectRatio = 1.0),
        dpStyle.copy(minWidth = 1.0),
        dpStyle.copy(maxWidth = 100.0),
        dpStyle.copy(minHeight = 1.0),
        dpStyle.copy(maxHeight = 100.0),
      )
    styles.forEach { assertNull(it.toString(), prototypeAuthoredImageSize(image(it))) }
    val anchored =
      image()
        .copy(
          source =
            PrototypeImageNode(
              asset = PrototypeModeValue.Single("hero"),
              anchor = PrototypeBoundsAnchor(PrototypeBounds(0.0, 0.0, 10.0, 10.0)),
            ),
        )
    assertNull(prototypeAuthoredImageSize(anchored))
    assertNull(
      prototypeAuthoredImageSize(
        image().copy(safeArea = PrototypeSafeAreaPadding(listOf("top"), listOf("statusBars"))),
      ),
    )
  }

  @Test
  fun `large fade and none candidates under neutral parents are accepted`() {
    val child = candidate("child")
    listOf("box", "scroll", "row", "column").forEach { role ->
      assertEquals(setOf("child"), retained(child, node("parent", role)))
      assertEquals(
        setOf("child"),
        retained(
          child.copy(
            source =
              (child.source as PrototypeBoxNode).copy(transition = PrototypeTransition("fade")),
          ),
          node("parent", role),
        ),
      )
    }
  }

  @Test
  fun `a node without visibleWhen is not retained`() {
    val child = candidate("child")
    assertTrue(
      retained(child.copy(source = (child.source as PrototypeBoxNode).copy(visibleWhen = null)))
        .isEmpty(),
    )
  }

  @Test
  fun `default expand and slide transitions are excluded`() {
    val child = candidate("child")
    listOf(null, "expand", "slide").forEach { transition ->
      assertTrue(
        retained(
            child.copy(
              source =
                (child.source as PrototypeBoxNode).copy(
                  transition = transition?.let(::PrototypeTransition),
                ),
            ),
          )
          .isEmpty(),
      )
    }
  }

  @Test
  fun `root pager page card and modal children are not candidates`() {
    val child = candidate("child")
    assertTrue(prototypeRetainedSubtrees(child).isEmpty())
    listOf("pager", "card", "bottomSheet", "dialog", "snackbar").forEach { role ->
      assertTrue(role, retained(child, node("parent", role)).isEmpty())
    }
    val belowModal = node("box", children = listOf(child))
    assertTrue(retained(belowModal, node("modal", "dialog")).isEmpty())
  }

  @Test
  fun `spacing and distributed arrangements exclude row and column parents`() {
    listOf("row", "column").forEach { role ->
      assertTrue(
        retained(candidate("child"), node("parent", role, style = PrototypeStyle(spacing = 1.0)))
          .isEmpty(),
      )
      listOf("spaceBetween", "spaceAround", "spaceEvenly").forEach { arrangement ->
        assertTrue(
          retained(
              candidate("child"),
              node("parent", role, style = PrototypeStyle(arrangement = arrangement)),
            )
            .isEmpty(),
        )
      }
      assertEquals(
        setOf("child"),
        retained(candidate("child"), node("parent", role, style = PrototypeStyle(spacing = 0.0))),
      )
    }
  }

  @Test
  fun `weight layered anchors and subminimum candidates are excluded`() {
    assertTrue(
      retained(candidate("child").copy(style = mapPrototypeStyle(PrototypeStyle(weight = 1.0))))
        .isEmpty(),
    )
    val child = candidate("child")
    assertTrue(
      retained(
          child.copy(
            source =
              (child.source as PrototypeBoxNode).copy(
                anchor = PrototypeBoundsAnchor(PrototypeBounds(0.0, 0.0, 10.0, 10.0)),
              ),
          ),
        )
        .isEmpty(),
    )
    assertTrue(retained(candidate("child", PROTOTYPE_RETAIN_MIN_NODES - 1)).isEmpty())
  }

  @Test
  fun `every excluded descendant role prevents retention`() {
    listOf(
        "textField",
        "pager",
        "timePicker",
        "datePicker",
        "progress",
        "bottomSheet",
        "dialog",
        "snackbar",
      )
      .forEach { role ->
        val child = candidate("child")
        assertTrue(
          role,
          retained(child.copy(children = child.children + node("excluded", role))).isEmpty(),
        )
      }
  }

  @Test
  fun `a layered descendant prevents retention`() {
    val anchor =
      node(
        "anchor",
        source =
          PrototypeBoxNode(
            children = emptyList(),
            anchor = PrototypeBoundsAnchor(PrototypeBounds(0.0, 0.0, 10.0, 10.0)),
          ),
      )
    val child = candidate("child")
    assertTrue(retained(child.copy(children = child.children + anchor)).isEmpty())
  }

  @Test
  fun `budget skips an oversized later subtree but admits a smaller later one`() {
    val root =
      node(
        "root",
        children =
          listOf(
            candidate("first", 400),
            candidate("skipped", 120),
            candidate("last", PROTOTYPE_RETAIN_MAX_NODES - 400),
          ),
      )
    assertEquals(setOf("first", "last"), prototypeRetainedSubtrees(root))
  }

  @Test
  fun `a nested accepted candidate costs no extra budget`() {
    val inner = candidate("inner")
    val outer =
      candidate("outer", PROTOTYPE_RETAIN_MAX_NODES - inner.children.size - 1).let {
        it.copy(children = it.children + inner)
      }
    assertEquals(setOf("outer", "inner"), retained(outer))
  }
}
