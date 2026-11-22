package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.BeforeClass
import org.junit.Test

class PrototypeRemoteImageBindingsTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val url = "https://images.example/photo.png"

  private fun spec(root: PrototypeNode, state: Map<String, PrototypeScalar>? = null) =
    PrototypeSpec("images", PrototypeWindow(PrototypeFullscreenPlacement()), state, root)

  private fun imageUrl(node: PrototypeRenderNode) = (node.source as PrototypeImageNode).url

  @Test
  fun `whole-field state and interpolated host bindings resolve before loading`() {
    val state =
      mapOf("photo" to PrototypeScalar.Text(url), "host" to PrototypeScalar.Text("images.example"))
    assertEquals(
      url,
      imageUrl(mapPrototypeSpec(spec(PrototypeImageNode(url = "{photo}"), state)).root),
    )
    assertEquals(
      url,
      imageUrl(
        mapPrototypeSpec(spec(PrototypeImageNode(url = "https://{host}/photo.png"), state)).root,
      ),
    )
  }

  @Test
  fun `whole-field data binding resolves into the image source`() {
    val spec =
      spec(PrototypeImageNode(url = "{data:/photo}"))
        .copy(data = JsonObject(mapOf("photo" to JsonPrimitive(url))))
    assertEquals(url, imageUrl(mapPrototypeSpec(spec).root))
  }

  @Test
  fun `whole-field repeat binding resolves separately for each mounted instance`() {
    val repeated =
      PrototypeColumnNode(
        repeat =
          PrototypeRepeat(
            listOf(
              mapOf("photo" to PrototypeScalar.Text(url)),
              mapOf("photo" to PrototypeScalar.Text("$url?second")),
            ),
            "row",
          ),
        children = listOf(PrototypeImageNode(url = "{row.photo}")),
      )
    assertEquals(
      listOf(url, "$url?second"),
      mapPrototypeSpec(spec(repeated)).root.children.map(::imageUrl),
    )
  }

  @Test
  fun `whole-field route binding uses the mounted screen parameters`() {
    val stack =
      PrototypeStackNode(
        id = "nav",
        start = "detail",
        screens = mapOf("detail" to PrototypeImageNode(url = "{route.photo}")),
        routes = mapOf("detail" to PrototypeRoute(params = mapOf("photo" to "string"))),
      )
    val snapshot =
      PrototypeStackSnapshot.of(
        listOf("detail"),
        listOf(JsonObject(mapOf("photo" to JsonPrimitive(url)))),
      )
    assertEquals(
      url,
      imageUrl(
        mapPrototypeSpec(spec(stack), stacks = mapOf("nav" to snapshot)).root.children.single(),
      ),
    )
  }
}
