package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.domain.NodeDiffState
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.serialization.json.Json
import org.junit.Test

/**
 * Coverage for parsing the daemon's per-frame `diffState` node annotation (issue #3758).
 * Hierarchies without the attribute must parse with a null [UIElementInfo.diffState] so the layout
 * inspector renders unchanged for daemons that do not emit diff metadata.
 */
class HierarchyParserDiffStateTest {

  private fun parse(hierarchyJson: String): ParsedHierarchy {
    val parsed = parseHierarchyFromJson(Json.parseToJsonElement(hierarchyJson))
    return assertNotNull(parsed, "hierarchy should parse")
  }

  @Test
  fun `parses added and changed diff states from node attributes`() {
    val json =
      """
      { "hierarchy": { "node": {
        "resource-id": "com.example:id/root",
        "diffState": "changed",
        "node": [
          { "resource-id": "com.example:id/added", "diffState": "added" },
          { "resource-id": "com.example:id/plain" }
        ]
      } } }
      """
    val root = parse(json).root

    assertEquals(NodeDiffState.Changed, root.diffState)
    assertEquals(NodeDiffState.Added, root.children[0].diffState)
    assertNull(root.children[1].diffState, "unmarked node has no diff state")
  }

  @Test
  fun `absent diff state parses as null`() {
    val json =
      """
      { "hierarchy": { "node": { "resource-id": "com.example:id/root" } } }
      """
    assertNull(parse(json).root.diffState)
  }

  @Test
  fun `unknown diff state value parses as null`() {
    // Forward compatibility: a future/unknown marker must not crash or mis-render.
    val json =
      """
      { "hierarchy": { "node": { "resource-id": "com.example:id/root", "diffState": "moved" } } }
      """
    assertNull(parse(json).root.diffState)
  }
}
