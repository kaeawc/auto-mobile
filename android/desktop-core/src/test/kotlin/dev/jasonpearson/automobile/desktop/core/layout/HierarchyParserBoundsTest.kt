package dev.jasonpearson.automobile.desktop.core.layout

import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlinx.serialization.json.Json
import org.junit.Test

/**
 * Bounds-shape coverage for [parseHierarchyFromJson] (issue #2990, task 3).
 *
 * The MCP server's `--observe-result-compact` flag flattens every `bounds` object `{left, top,
 * right, bottom}` to the positional tuple `[left, top, right, bottom]`. PR #2976 taught the sibling
 * `RealLayoutDataSource.parseBounds` the tuple form but left `HierarchyParser.parseBoundsElement`
 * object/string-only — so the three live `parseHierarchyFromJson` consumers (AutoMobileContent,
 * LayoutInspectorDashboard, TelemetryDetailPanel) would silently render every element at a zero
 * rect when the flag is on. These tests pin object, legacy-string, and compact-tuple parity.
 */
class HierarchyParserBoundsTest {

  private fun parse(hierarchyJson: String): ParsedHierarchy {
    val parsed = parseHierarchyFromJson(Json.parseToJsonElement(hierarchyJson))
    return assertNotNull(parsed, "hierarchy should parse")
  }

  private val expected = ElementBounds(left = 10, top = 20, right = 300, bottom = 400)

  @Test
  fun `parses object-shaped bounds`() {
    val json =
      """
      { "hierarchy": { "node": {
        "resource-id": "com.example:id/root",
        "bounds": { "left": 10, "top": 20, "right": 300, "bottom": 400 }
      } } }
      """
    assertEquals(expected, parse(json).root.bounds)
  }

  @Test
  fun `parses legacy uiautomator string bounds`() {
    val json =
      """
      { "hierarchy": { "node": {
        "resource-id": "com.example:id/root",
        "bounds": "[10,20][300,400]"
      } } }
      """
    assertEquals(expected, parse(json).root.bounds)
  }

  @Test
  fun `parses compact tuple bounds emitted by --observe-result-compact`() {
    val json =
      """
      { "hierarchy": { "node": {
        "resource-id": "com.example:id/root",
        "bounds": [10, 20, 300, 400]
      } } }
      """
    assertEquals(expected, parse(json).root.bounds)
  }

  @Test
  fun `object and compact-tuple bounds parse identically (round-trip parity)`() {
    val objectJson =
      """{ "hierarchy": { "node": { "resource-id": "r", "bounds": { "left": 1, "top": 2, "right": 3, "bottom": 4 } } } }"""
    val tupleJson =
      """{ "hierarchy": { "node": { "resource-id": "r", "bounds": [1, 2, 3, 4] } } }"""
    assertEquals(parse(objectJson).root.bounds, parse(tupleJson).root.bounds)
  }

  @Test
  fun `malformed tuple (wrong arity) does not crash and yields a non-null root`() {
    val json = """{ "hierarchy": { "node": { "resource-id": "r", "bounds": [1, 2, 3] } } }"""
    // Falls back to the zero rect rather than throwing.
    assertEquals(ElementBounds(0, 0, 0, 0), parse(json).root.bounds)
  }
}
