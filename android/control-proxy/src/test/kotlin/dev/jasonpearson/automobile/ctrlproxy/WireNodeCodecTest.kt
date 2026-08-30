package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Wire-compatibility guard for issue #5471.
 *
 * `UIElementInfo` moved children from a serialized `JsonElement` subtree to a typed in-memory
 * [UIElementInfo.children] list, with the wire `node` projection produced once at the boundary by
 * [WireNodeCodec]. This test proves the emitted JSON is byte-for-byte identical to the pre-refactor
 * format. [WIRE_GOLDEN] was captured from the base commit (before this change) by serializing the
 * exact same logical tree with the production `jsonCompact` config.
 */
@RunWith(RobolectricTestRunner::class)
class WireNodeCodecTest {

  // Mirrors CtrlProxy.jsonCompact — the config used to serialize hierarchy frames onto the wire.
  private val jsonCompact = Json {
    prettyPrint = false
    encodeDefaults = true
  }

  private fun grandchild() =
    UIElementInfo(
      text = "Grandchild",
      resourceId = "com.example:id/gc",
      viewId = "com.example:id/gc",
      className = "android.widget.TextView",
      bounds = ElementBounds(0, 0, 10, 10),
      clickable = "true",
      actions = listOf("click", "focus"),
      extras = mapOf("k" to "v"),
    )

  private fun childA() =
    UIElementInfo(
      text = "ChildA",
      bounds = ElementBounds(0, 0, 20, 20),
      children = listOf(grandchild()),
    )

  private fun childB() =
    UIElementInfo(
      contentDesc = "ChildB",
      bounds = ElementBounds(0, 20, 20, 40),
      collectionRowIndex = 2,
      collectionColumnIndex = 1,
      visibleToUser = false,
    )

  private fun root() =
    UIElementInfo(
      className = "android.widget.FrameLayout",
      bounds = ElementBounds(0, 0, 20, 40),
      children = listOf(childA(), childB()),
    )

  private fun representativeHierarchy(): ViewHierarchy =
    ViewHierarchy(
      updatedAt = 123L,
      packageName = "com.example.app",
      // Synthetic root wrapper, exactly as the extractor builds it before materializing.
      hierarchy = WireNodeCodec.materialize(UIElementInfo(children = listOf(root()))),
    )

  @Test
  fun `serialized wire JSON is byte-identical to the pre-refactor format`() {
    val wire = jsonCompact.encodeToString(ViewHierarchy.serializer(), representativeHierarchy())
    assertEquals(WIRE_GOLDEN, wire)
  }

  @Test
  fun `single child materializes as an object and multiple as an array`() {
    val singleChildNode = WireNodeCodec.buildNodeJson(listOf(childB()))
    assertTrue(
      "single child must serialize as an object",
      singleChildNode.toString().startsWith("{"),
    )

    val multiChildNode = WireNodeCodec.buildNodeJson(listOf(childA(), childB()))
    assertTrue(
      "multiple children must serialize as an array",
      multiChildNode.toString().startsWith("["),
    )

    assertNull("no children must serialize as null node", WireNodeCodec.buildNodeJson(emptyList()))
  }

  @Test
  fun `nested nodes omit null fields while the top wrapper stays verbose`() {
    val wire = jsonCompact.encodeToString(ViewHierarchy.serializer(), representativeHierarchy())
    // Verbose top wrapper carries explicit nulls.
    assertTrue(wire.contains(""""hierarchy":{"text":null"""))
    // Nested child under `node` is compact — no null keys (e.g. ChildB never emits "text":null).
    assertTrue(wire.contains(""""content-desc":"ChildB","bounds""""))
  }

  companion object {
    // Captured on the base commit (pre-#5471) from the production jsonCompact serializer.
    private const val WIRE_GOLDEN =
      """{"updatedAt":123,"packageName":"com.example.app","userId":null,"hierarchy":{"text":null,"textSize":null,"text-color":null,"content-desc":null,"resource-id":null,"view-id":null,"className":null,"bounds":null,"clickable":null,"enabled":null,"focusable":null,"focused":null,"accessibility-focused":null,"scrollable":null,"password":null,"checkable":null,"checked":null,"selected":null,"long-clickable":null,"fragment":null,"test-tag":null,"unique-id":null,"visible-to-user":null,"container-title":null,"role":null,"state-description":null,"error-message":null,"hint-text":null,"tooltip-text":null,"pane-title":null,"live-region":null,"collection-info":null,"collection-item-info":null,"collection-row-index":null,"collection-column-index":null,"range-info":null,"input-type":null,"actions":null,"extras":null,"occlusionState":null,"occludedBy":null,"occludedByViewId":null,"recomposition":null,"node":{"className":"android.widget.FrameLayout","bounds":{"left":0,"top":0,"right":20,"bottom":40},"node":[{"text":"ChildA","bounds":{"left":0,"top":0,"right":20,"bottom":20},"node":{"text":"Grandchild","resource-id":"com.example:id/gc","view-id":"com.example:id/gc","className":"android.widget.TextView","bounds":{"left":0,"top":0,"right":10,"bottom":10},"clickable":"true","actions":["click","focus"],"extras":{"k":"v"}}},{"content-desc":"ChildB","bounds":{"left":0,"top":20,"right":20,"bottom":40},"visible-to-user":false,"collection-row-index":2,"collection-column-index":1}]}},"windowInfo":null,"windows":null,"contentHiddenRegions":null,"intentChooserDetected":null,"notificationPermissionDetected":null,"accessibility-focused-element":null,"ctrlProxyIncomplete":null,"error":null,"screenWidth":null,"screenHeight":null,"rotation":null,"systemInsets":null,"insets":null,"wakefulness":null,"foregroundActivity":null,"density":null,"sdkInt":null,"deviceModel":null,"isEmulator":null,"nativeScale":null,"pixelWidth":null,"pixelHeight":null,"truncationReasons":null}"""
  }
}
