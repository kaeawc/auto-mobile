package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorTraversalIdentityTest : ViewHierarchyExtractorFixtures() {

  // MARK: - Node Relationship Tests

  @Test
  fun `determineNodeRelationship detects direct siblings`() {
    // Two nodes with same parent "0.0.0" - they are siblings
    val nodePath = "0.0.0.0"
    val occluderPath = "0.0.0.1"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 5,
        nodeSubtreeEnd = 5,
        occluderOrder = 6,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.SIBLING, relationship)
  }

  @Test
  fun `determineNodeRelationship detects uncles - sibling of parent`() {
    // Node at "0.0.0.1.0" (child of "0.0.0.1")
    // Occluder at "0.0.0.2" (sibling of "0.0.0.1", which is the node's parent)
    // This is the NavigationBar case - occluder is uncle of node
    val nodePath = "0.0.0.1.0"
    val occluderPath = "0.0.0.2"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 10,
        occluderOrder = 11,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNCLE, relationship)
  }

  @Test
  fun `determineNodeRelationship detects uncles - sibling of grandparent`() {
    // Node deeply nested at "0.0.0.1.0.0"
    // Occluder at "0.0.0.2" (sibling of grandparent)
    val nodePath = "0.0.0.1.0.0"
    val occluderPath = "0.0.0.2"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 15,
        nodeSubtreeEnd = 15,
        occluderOrder = 16,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNCLE, relationship)
  }

  @Test
  fun `determineNodeRelationship detects descendants using traversal order`() {
    // Occluder is a child of the node (traversal order within subtree)
    val nodePath = "0.0.0.1"
    val occluderPath = "0.0.0.1.0"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 15, // Subtree ends at 15
        occluderOrder = 11, // Child is at 11, within [10, 15]
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.DESCENDANT, relationship)
  }

  @Test
  fun `determineNodeRelationship detects descendants with multiple children`() {
    // Node has multiple descendants
    val nodePath = "0.0.0.1"
    val occluderPath = "0.0.0.1.2.0"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 20,
        occluderOrder = 18, // Deep descendant within subtree
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.DESCENDANT, relationship)
  }

  @Test
  fun `determineNodeRelationship detects unrelated nodes - different branches`() {
    // Nodes in completely different branches
    val nodePath = "0.0.0.1.0"
    val occluderPath = "0.0.1.0.0"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 12,
        occluderOrder = 20,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNRELATED, relationship)
  }

  @Test
  fun `determineNodeRelationship detects unrelated nodes - cousin relationship`() {
    // Cousins: share grandparent but different parents
    val nodePath = "0.0.0.1.0"
    val occluderPath = "0.0.0.2.0"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 10,
        occluderOrder = 15,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNRELATED, relationship)
  }

  @Test
  fun `determineNodeRelationship handles root node edge case`() {
    // Root-level siblings (empty parent path)
    val nodePath = "0"
    val occluderPath = "1"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 0,
        nodeSubtreeEnd = 100,
        occluderOrder = 101,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.SIBLING, relationship)
  }

  @Test
  fun `determineNodeRelationship TabRow structure - text and role description as siblings`() {
    // Real TabRow case: Text "Tap" and role description are siblings
    val textPath = "0.0.0.0.0.0.1.0.0.0.0"
    val roleDescPath = "0.0.0.0.0.0.1.0.0.0.1"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = textPath,
        occluderPath = roleDescPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 10,
        occluderOrder = 11,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.SIBLING, relationship)
  }

  @Test
  fun `determineNodeRelationship NavigationBar structure - text nested with uncle`() {
    // Real NavigationBar case: Text is nested, occluder is uncle
    // Text: "0.0.0.0.0.0.1.0.0.1.0" (in wrapper "0.0.0.0.0.0.1.0.0.1")
    // Occluder: "0.0.0.0.0.0.1.0.0.2" (sibling of wrapper's parent)
    val textPath = "0.0.0.0.0.0.1.0.0.1.0"
    val occluderPath = "0.0.0.0.0.0.1.0.0.2"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = textPath,
        occluderPath = occluderPath,
        nodeOrder = 10,
        nodeSubtreeEnd = 10,
        occluderOrder = 11,
      )

    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNCLE, relationship)
  }

  @Test
  fun `determineNodeRelationship root-level promoted header is related to deep content occluder`() {
    // The real channel-header scenario, with paths in the correct traversal direction.
    // In the Slack Box, ChannelHeader is child 0 (traversed first) and the content fragment is
    // child 1 (traversed later). optimizeHierarchy promotes the header's bounds-only wrappers, so
    // the header lands at a shallow root-level path "0" (empty parent, low pre-order), while the
    // content subtree stays deeply nested at e.g. "1.0.0.3" (higher pre-order). Because the content
    // has the higher order, it is the *occluder* and the header is the *node* — the header's empty
    // parent path makes them share the implicit root, so they are SIBLING (never UNRELATED).
    val nodePath = "0" // promoted header, root-level, traversed first (low order)
    val occluderPath = "1.0.0.3" // deep content child, traversed later (high order)

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 1,
        nodeSubtreeEnd = 1,
        occluderOrder = 9,
      )

    // Node's parent "" is empty → shares the implicit root with the occluder → SIBLING
    assertEquals(ViewHierarchyExtractor.NodeRelationship.SIBLING, relationship)
  }

  @Test
  fun `determineNodeRelationship root-level node is related to deep nested node`() {
    // Root-level promoted node should not be UNRELATED to nodes in sibling branches.
    // This prevents false occlusion after optimizeHierarchy flattens the tree.
    val nodePath = "2"
    val occluderPath = "0.1.0.2.0"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 80,
        nodeSubtreeEnd = 80,
        occluderOrder = 30,
      )

    // Node's parent "" is empty → SIBLING (shares implicit root)
    assertEquals(ViewHierarchyExtractor.NodeRelationship.SIBLING, relationship)
  }

  @Test
  fun `determineNodeRelationship detects nephew at intermediate depth`() {
    // Non-root nephew case: node at "0.1" is uncle of occluder at "0.1.2.3.4"
    // because node's parent "0" is a prefix of occluder's path
    val nodePath = "0.1"
    val occluderPath = "0.1.2.3.4"

    val relationship =
      extractor.determineNodeRelationship(
        nodePath = nodePath,
        occluderPath = occluderPath,
        nodeOrder = 5,
        nodeSubtreeEnd = 5,
        occluderOrder = 20,
      )

    // occluder is a descendant check first: occluderOrder(20) > nodeOrder(5) && 20 <= 5? NO
    // Then: nodeParent="0", occluderParent="0.1.2.3" → not equal
    // Uncle check: occluderParent "0.1.2.3" prefix of "0.1"? NO
    // Nephew check: nodeParent "0" prefix of "0.1.2.3.4"? "0.1.2.3.4".startsWith("0.") → YES
    assertEquals(ViewHierarchyExtractor.NodeRelationship.UNCLE, relationship)
  }

  // MARK: - viewId Generation Tests

  @Test
  fun `UIElementInfo with resourceId gets viewId equal to resourceId`() {
    val element =
      UIElementInfo(resourceId = "com.example:id/my_button", viewId = "com.example:id/my_button")
    assertEquals("com.example:id/my_button", element.viewId)
  }

  @Test
  fun `UIElementInfo without resourceId gets UUID-formatted viewId`() {
    val uuidRegex = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    val viewId = extractor.generateDeterministicUuidForTest("0/1/2")
    assertTrue("viewId should be UUID-formatted but was: $viewId", uuidRegex.matches(viewId))
  }

  @Test
  fun `generateDeterministicUuid is stable - same input produces same output`() {
    val first = extractor.generateDeterministicUuidForTest("some/path/0")
    val second = extractor.generateDeterministicUuidForTest("some/path/0")
    assertEquals(first, second)
  }

  @Test
  fun `generateDeterministicUuid produces different UUIDs for different paths`() {
    val uuid1 = extractor.generateDeterministicUuidForTest("0/1/0")
    val uuid2 = extractor.generateDeterministicUuidForTest("0/1/1")
    assertTrue("Different paths should produce different UUIDs", uuid1 != uuid2)
  }

  @Test
  fun `viewId field is serialized to JSON with correct key`() {
    val element =
      UIElementInfo(
        text = "Hello",
        resourceId = "com.example:id/text",
        viewId = "com.example:id/text",
      )
    val jsonString = json.encodeToString(UIElementInfo.serializer(), element)
    assertTrue("JSON should contain view-id field", jsonString.contains("\"view-id\""))
  }

  @Test
  fun `occludedByViewId field is serialized to JSON with correct key`() {
    val element =
      UIElementInfo(
        text = "Covered",
        occlusionState = "partial",
        occludedBy = "unlabeled view",
        occludedByViewId = "stable-unlabeled-occluder",
      )
    val jsonString = json.encodeToString(UIElementInfo.serializer(), element)
    assertTrue(
      "JSON should contain occludedByViewId field",
      jsonString.contains("\"occludedByViewId\""),
    )
  }

  private fun ViewHierarchyExtractor.generateDeterministicUuidForTest(path: String): String {
    val method = this.javaClass.getDeclaredMethod("generateDeterministicUuid", String::class.java)
    method.isAccessible = true
    return method.invoke(this, path) as String
  }

  // optimizeHierarchy is internal (its Kotlin name is mangled), so call it directly, not
  // reflectively.
  private fun ViewHierarchyExtractor.optimizeHierarchyForTest(
    element: UIElementInfo,
  ): List<UIElementInfo> = optimizeHierarchy(element)

  // Issue #5471: the optimize pass walks typed children and performs ZERO serialization, so every
  // element it returns still has a null `node` (the wire projection is built only at the boundary).
  @Test
  fun `optimize pass performs no intermediate serialization`() {
    val leaf = UIElementInfo(text = "leaf", clickable = "true")
    val interactiveParent = UIElementInfo(text = "row", clickable = "true", children = listOf(leaf))
    val boundsOnlyWrapper =
      UIElementInfo(bounds = ElementBounds(0, 0, 100, 100), children = listOf(interactiveParent))

    val optimized = extractor.optimizeHierarchyForTest(boundsOnlyWrapper)

    fun assertNoNode(element: UIElementInfo) {
      assertNull("pipeline must not materialize node before the wire boundary", element.node)
      element.children.forEach(::assertNoNode)
    }
    optimized.forEach(::assertNoNode)

    // The bounds-only wrapper is promoted away; its interactive child (with its typed leaf)
    // remains.
    assertEquals(1, optimized.size)
    assertEquals("row", optimized.single().text)
    assertEquals("leaf", optimized.single().children.single().text)
  }
}
