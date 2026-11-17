package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class PrototypeSwipeSemanticsTest {
  private val swipe =
    PrototypeSwipeActions(
      start = listOf(PrototypeSwipeAction("Pin", onTap = listOf(PrototypeEmitAction("pin")))),
      end =
        listOf(
          PrototypeSwipeAction(
            "Delete",
            role = "destructive",
            onTap = listOf(PrototypeEmitAction("del")),
          ),
          PrototypeSwipeAction("Archive", onTap = listOf(PrototypeEmitAction("arc"))),
        ),
    )
  private val row =
    PrototypeRowNode(
      testTag = "order",
      children = listOf(PrototypeTextNode(text = "Latte")),
      swipeActions = swipe,
    )

  private fun render(coordinator: SwipeCoordinator? = null): SemanticsNode {
    val spec = PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), root = row)
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    activity.setContent {
      CompositionLocalProvider(LocalPrototypeSwipeCoordinator provides coordinator) {
        PrototypeSpecContent(mapPrototypeSpec(spec).root)
      }
    }
    shadowOf(Looper.getMainLooper()).idle()
    val view = checkNotNull(composeView(activity.window.decorView))
    return (view as RootForTest).semanticsOwner.unmergedRootSemanticsNode
  }

  private fun renderColumn(
    column: PrototypeRenderNode,
    coordinator: SwipeCoordinator? = null,
  ): SemanticsNode {
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    activity.setContent {
      CompositionLocalProvider(LocalPrototypeSwipeCoordinator provides coordinator) {
        Box(Modifier.width(300.dp).height(400.dp)) {
          PrototypeSpecContent(column)
        }
      }
    }
    shadowOf(Looper.getMainLooper()).idle()
    val view = checkNotNull(composeView(activity.window.decorView))
    return (view as RootForTest).semanticsOwner.unmergedRootSemanticsNode
  }

  private fun composeView(view: View): View? =
    if (view is RootForTest) view
    else if (view is ViewGroup)
      (0 until view.childCount).firstNotNullOfOrNull { composeView(view.getChildAt(it)) }
    else null

  private fun SemanticsNode.all(): List<SemanticsNode> =
    listOf(this) + children.flatMap { it.all() }

  private fun SemanticsNode.tags() =
    all().mapNotNull { it.config.getOrNull(SemanticsProperties.TestTag) }

  @Test
  fun `an open delete action stays at the content row height inside a tall column`() {
    val row = row.copy(swipeActions = PrototypeSwipeActions(end = swipe.end?.take(1)))
    val column =
      mapPrototypeSpec(
          PrototypeSpec(
            "panel",
            PrototypeWindow(PrototypeFullscreenPlacement()),
            root =
              PrototypeColumnNode(
                testTag = "column",
                children =
                  listOf(
                    row,
                    PrototypeTextNode(text = "Other orders"),
                    PrototypeTextNode(text = "More content below the swipe row"),
                  ),
              ),
          ),
        )
        .root
    val closed = renderColumn(column)
    val closedRowHeight =
      closed
        .all()
        .first { it.config.getOrNull(SemanticsProperties.TestTag) == "order" }
        .boundsInRoot
        .height
    val identity = column.children.single { it.testTag == "order" }.identity
    val coordinator = SwipeCoordinator()
    coordinator.opened(identity, SwipeSide.END)
    val open = renderColumn(column, coordinator)
    val heights =
      open
        .all()
        .mapNotNull { node ->
          node.config.getOrNull(SemanticsProperties.TestTag)?.let { it to node.boundsInRoot.height }
        }
        .toMap()
    assertTrue(closedRowHeight > 0f)
    assertEquals(closedRowHeight, heights.getValue("order.swipe.0"), 0f)
    assertTrue(heights.getValue("order.swipe.0") < heights.getValue("column"))
  }

  @Test
  fun `a closed row exposes every entry as an accessibility action and composes no button`() {
    val root = render()
    val labels =
      root
        .all()
        .flatMap { it.config.getOrNull(SemanticsActions.CustomActions).orEmpty() }
        .map { it.label }
    assertEquals(listOf("Pin", "Delete", "Archive"), labels)
    assertTrue(root.tags().contains("order"))
    assertFalse(root.tags().any { it.contains(".swipe.") })
  }

  @Test
  fun `an open row shows tagged buttons indexed start first then end`() {
    val coordinator = SwipeCoordinator()
    val root0 = render()
    val identity =
      checkNotNull(
        mapPrototypeSpec(
            PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), root = row),
          )
          .root
          .identity,
      )
    coordinator.opened(identity, SwipeSide.END)
    val root = render(coordinator)
    val tags = root.tags().filter { it.contains(".swipe.") }
    assertTrue(root0.tags().none { it.contains(".swipe.") })
    assertEquals(listOf("order.swipe.1", "order.swipe.2"), tags.sorted())
    val labels = tags.associateWith { tag ->
      root
        .all()
        .first { it.config.getOrNull(SemanticsProperties.TestTag) == tag }
        .config
        .getOrNull(SemanticsProperties.ContentDescription)
        ?.single()
    }
    assertEquals("Delete", labels["order.swipe.1"])
    assertEquals("Archive", labels["order.swipe.2"])
  }
}
