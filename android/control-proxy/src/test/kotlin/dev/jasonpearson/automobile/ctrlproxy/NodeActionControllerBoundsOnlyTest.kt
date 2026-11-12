package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.NodeActionControllerTestSupport.boundsNode
import dev.jasonpearson.automobile.ctrlproxy.NodeActionControllerTestSupport.expectedBounds
import dev.jasonpearson.automobile.ctrlproxy.NodeActionControllerTestSupport.setup
import dev.jasonpearson.automobile.ctrlproxy.NodeActionControllerTestSupport.tree
import io.mockk.every
import io.mockk.verify
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26])
class NodeActionControllerBoundsOnlyTest {
  @Test
  fun `bounds-only scrolling requires a unique visible node advertising the requested action`() =
    runTest {
      for (action in listOf("scroll_forward", "scroll_backward")) {
        val actionId =
          if (action == "scroll_forward") AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
          else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        for (mode in listOf("match", "missing-action", "ambiguous", "hidden")) {
          val (controller, host) = setup()
          val target = boundsNode(visible = mode != "hidden")
          every { target.actionList } returns
            if (mode == "missing-action") emptyList()
            else listOf(AccessibilityNodeInfo.AccessibilityAction(actionId, null))
          val duplicate = boundsNode()
          every { duplicate.actionList } returns
            listOf(AccessibilityNodeInfo.AccessibilityAction(actionId, null))
          host.windowRoots =
            if (mode == "ambiguous") listOf(tree(target), tree(duplicate)) else listOf(tree(target))

          controller.performNodeAction(
            "bounds-scroll",
            action,
            NodeActionTarget(),
            boundsConstraint = NodeBoundsConstraint(expectedBounds, allowInvisible = true),
          )
          advanceUntilIdle()

          assertEquals(mode == "match", host.results.single().success)
          verify(exactly = if (mode == "match") 1 else 0) { target.performAction(actionId) }
          verify(exactly = 0) { target.performAction(AccessibilityNodeInfo.ACTION_CLICK) }
          verify(exactly = 1) { target.recycle() }
        }
      }
    }

  @Test
  fun `bounds-only switch click verifies checkable without depending on toggle state`() = runTest {
    for (checkable in listOf(true, false)) {
      val (controller, host) = setup()
      val target = boundsNode()
      every { target.isCheckable } returns checkable
      host.windowRoots = listOf(tree(target))
      controller.performNodeAction(
        "switch",
        "click",
        NodeActionTarget(),
        boundsConstraint =
          NodeBoundsConstraint(expectedBounds, NodeIdentityHints(checkable = true)),
      )
      advanceUntilIdle()
      assertEquals(checkable, host.results.single().success)
      if (!checkable)
        assertTrue(host.results.single().error!!.startsWith("node_identity_mismatch:"))
      verify(exactly = if (checkable) 1 else 0) {
        target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
      }
    }
  }
}
