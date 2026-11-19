package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/** Inserted data, row and derived values are never read again as placeholders (#18628). */
class PrototypeInsertedTextLiteralTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmMapping() {
      PrototypeInsertedTextLiteralTest().`eager rows, data and derived values render literally`()
      PrototypeInsertedTextLiteralTest().`lazy list row values render literally`()
    }
  }

  private val window = PrototypeWindow(PrototypeFullscreenPlacement())
  private val state = mapOf("secret" to PrototypeScalar.Text("LEAK"))
  private val derive =
    mapOf("x" to PrototypeDerivedEntry(of = buildJsonObject { put("data", "/raw") }))
  private val data = buildJsonObject {
    put("note", "{secret}")
    put("raw", "{secret}")
    put(
      "items",
      JsonArray(
        listOf(
          buildJsonObject {
            put("id", 0)
            put("title", "{secret}")
          },
          buildJsonObject {
            put("id", 1)
            put("title", "{derived:x}")
          },
        ),
      ),
    )
  }

  private fun texts(node: PrototypeRenderNode, tag: String): List<String> =
    listOfNotNull(node.text.takeIf { node.testTag == tag }) +
      node.children.flatMap { texts(it, tag) }

  @Test
  fun `eager rows, data and derived values render literally`() {
    val spec =
      PrototypeSpec(
        "literal",
        window,
        root =
          PrototypeColumnNode(
            children =
              listOf(
                PrototypeTextNode(testTag = "authored", text = "{secret} {derived:x}"),
                PrototypeTextNode(testTag = "data", text = "{data:/note}"),
                PrototypeTopAppBarNode(testTag = "bar", title = "{data:/note}"),
                PrototypeColumnNode(
                  repeat =
                    PrototypeRepeat(
                      listOf(
                        mapOf("label" to PrototypeScalar.Text("{secret}")),
                        mapOf("label" to PrototypeScalar.Text("{derived:x}")),
                      ),
                      "item",
                    ),
                  children =
                    listOf(
                      PrototypeTextNode(testTag = "row", text = "{item.label}|{secret}"),
                      PrototypeListItemNode(testTag = "head", headline = "{item.label}"),
                    ),
                ),
              ),
          ),
        state = state,
        data = data,
        derive = derive,
      )
    val root = mapPrototypeSpec(spec).root
    // Authored placeholders still resolve; a derived value is inserted literally.
    assertEquals(listOf("LEAK {secret}"), texts(root, "authored"))
    assertEquals(listOf("{secret}"), texts(root, "data"))
    assertEquals(listOf("{secret}"), texts(root, "bar"))
    assertEquals(listOf("{secret}|LEAK", "{derived:x}|LEAK"), texts(root, "row"))
    assertEquals(listOf("{secret}", "{derived:x}"), texts(root, "head"))
  }

  @Test
  fun `lazy list row values render literally`() {
    val spec =
      PrototypeSpec(
        "lazy",
        window,
        root =
          PrototypeListNode(
            testTag = "feed",
            repeat = PrototypeRepeat(emptyList(), "post", "/items", "id"),
            children = listOf(PrototypeTextNode(text = "{post.title} {secret}", testTag = "row")),
          ),
        state = state,
        data = data,
        derive = derive,
      )
    val list = checkNotNull(mapPrototypeSpec(spec).root.list)
    assertEquals("{secret} LEAK", list.render(list.rows[0], 0).text)
    assertEquals("{derived:x} LEAK", list.render(list.rows[1], 1).text)
  }
}
