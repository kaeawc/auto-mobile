package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.protocol.NodeSelector
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NodeSelectorTest {
  @Test
  fun `test tag selects a repeated row with a shared resource ID`() {
    val selector =
      NodeSelector(resourceId = "com.example:id/row", testTag = "message_row_42")
    val target =
      NodeSelectorFields(
        resourceId = "com.example:id/row",
        testTag = "message_row_42",
        uniqueId = null,
        collectionRow = 4,
        collectionColumn = 0,
      )
    val sibling = target.copy(testTag = "message_row_43")

    assertTrue(nodeSelectorMatches(selector, target))
    assertFalse(nodeSelectorMatches(selector, sibling))
  }

  @Test
  fun `collection coordinates disambiguate rows sharing an ID`() {
    val selector =
      NodeSelector(resourceId = "row", collectionRow = 4, collectionColumn = 0)
    val target =
      NodeSelectorFields(
        resourceId = "com.example:id/row",
        testTag = null,
        uniqueId = null,
        collectionRow = 4,
        collectionColumn = 0,
      )

    assertTrue(nodeSelectorMatches(selector, target))
    assertFalse(nodeSelectorMatches(selector, target.copy(collectionRow = 5)))
    assertFalse(nodeSelectorMatches(selector, target.copy(collectionColumn = 1)))
  }

  @Test
  fun `Android unique ID matches only the observed node`() {
    val selector = NodeSelector(uniqueId = "android-node-7")
    val target =
      NodeSelectorFields(
        resourceId = null,
        testTag = null,
        uniqueId = "android-node-7",
        collectionRow = null,
        collectionColumn = null,
      )

    assertTrue(nodeSelectorMatches(selector, target))
    assertFalse(nodeSelectorMatches(selector, target.copy(uniqueId = "android-node-8")))
  }

  @Test
  fun `empty selectors do not match nodes`() {
    assertFalse(
      nodeSelectorMatches(
        NodeSelector(),
        NodeSelectorFields(
          resourceId = "com.example:id/row",
          testTag = "message_row_42",
          uniqueId = "android-node-7",
          collectionRow = 4,
          collectionColumn = 0,
        ),
      )
    )
  }

  @Test
  fun `unavailable advertised action is reported before performing it`() {
    assertEquals(
      "Accessibility action is unavailable: long_click",
      nodeActionFailure("long_click", listOf(AccessibilityNodeInfo.ACTION_CLICK)),
    )
    assertNull(
      nodeActionFailure(
        "long_click",
        listOf(AccessibilityNodeInfo.ACTION_CLICK, AccessibilityNodeInfo.ACTION_LONG_CLICK),
      )
    )
  }

  @Test
  fun `unsupported actions are reported without attempting a node action`() {
    assertEquals(
      "Unsupported accessibility action: activate",
      nodeActionFailure("activate", null),
    )
  }
}
