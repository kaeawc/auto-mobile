package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import dev.jasonpearson.automobile.protocol.PrototypeColumnNode
import dev.jasonpearson.automobile.protocol.PrototypeEmitAction
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeIconNode
import dev.jasonpearson.automobile.protocol.PrototypeRepeat
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSearchBarNode
import dev.jasonpearson.automobile.protocol.PrototypeSemantics
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeTextNode
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeStringsSemanticsTest {
  @get:Rule val compose = createComposeRule()

  private val spec =
    PrototypeSpec(
      "strings",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      state = mapOf("name" to PrototypeScalar.Text("Ada")),
      data = Json.parseToJsonElement("""{"n":3}""").jsonObject,
      strings =
        Json.parseToJsonElement(
            """{"default":{"items":{"one":"{#} item {name}","other":"{#} items {name}"}},
        "ar":{"items":{"few":"{#} few {name}","other":"{#} other {name}"}}}""",
          )
          .jsonObject,
      root = PrototypeTextNode(testTag = "text", text = "{t:items|{data:/n}}"),
    )

  @Test
  fun `semantics bind data translations repeat values and state`() {
    val template =
      PrototypeTextNode(
        text = "Row",
        semantics =
          PrototypeSemantics(label = "{t:name} {item.label} {name}", hint = "{data:/n} {index}"),
      )
    val repeated =
      spec.copy(
        strings = Json.parseToJsonElement("""{"default":{"name":"Hello"}}""").jsonObject,
        root =
          PrototypeColumnNode(
            children = listOf(template),
            repeat = PrototypeRepeat(listOf(mapOf("label" to PrototypeScalar.Text("Row"))), "item"),
          ),
      )
    val node = PrototypeRenderMapper().map(repeated, emptyMap()).root.children.single()
    assertEquals("Hello Row Ada", node.semantics?.label)
    assertEquals("3 0", node.semantics?.hint)
  }

  @Test
  fun `semantics prevent decorative visual and container skips and tap-label flattening`() {
    val icon =
      mapPrototypeSpec(
          spec.copy(
            root =
              PrototypeIconNode(
                name = "home",
                semantics = PrototypeSemantics(heading = true),
              ),
          ),
        )
        .root
    org.junit.Assert.assertFalse(isDecorativePrototypeVisual(icon, false))
    val container =
      mapPrototypeSpec(
          spec.copy(
            root =
              PrototypeColumnNode(
                semantics = PrototypeSemantics(group = true),
                children = emptyList(),
              ),
          ),
        )
        .root
    org.junit.Assert.assertFalse(isSemanticsFreeContainer(container, false, null, null))
    org.junit.Assert.assertNull(prototypeMergedTapLabel(container, true))
  }

  @Test
  fun `mapper caches by effective locale and resolves data then strings then state`() {
    val mapper = PrototypeRenderMapper()
    val english = mapper.map(spec, emptyMap(), locales = listOf("en"))
    assertEquals("3 items Ada", english.root.text)
    assertSame(english, mapper.map(spec, emptyMap(), locales = listOf("en")))
    val arabic = mapper.map(spec, emptyMap(), locales = listOf("ar"))
    assertNotSame(english, arabic)
    assertEquals("3 few Ada", arabic.root.text)
    assertEquals("3 items Ada", mapper.map(spec, emptyMap(), locales = listOf("de")).root.text)
  }

  @Test
  fun `same shown spec renders English Arabic plurals and default fallback`() {
    val locales = mutableStateOf(listOf("en"))
    val mapper = PrototypeRenderMapper()
    compose.setContent {
      PrototypeSpecContent(mapper.map(spec, emptyMap(), locales = locales.value).root) {}
    }
    compose.onNodeWithTag("text").assertTextEquals("3 items Ada")
    compose.runOnIdle { locales.value = listOf("ar") }
    compose.onNodeWithTag("text").assertTextEquals("3 few Ada")
    compose.runOnIdle { locales.value = listOf("de") }
    compose.onNodeWithTag("text").assertTextEquals("3 items Ada")
  }

  @Test
  fun `authored semantics survive otherwise empty containers`() {
    val root =
      PrototypeColumnNode(
        testTag = "group",
        semantics =
          PrototypeSemantics(
            heading = true,
            liveRegion = "assertive",
            group = true,
            label = "Name {name}",
            hint = "Extra guidance",
            traits = listOf("image", "selected"),
          ),
        children = emptyList(),
      )
    val model = mapPrototypeSpec(spec.copy(root = root))
    compose.setContent { PrototypeSpecContent(model.root) {} }
    compose
      .onNodeWithTag("group")
      .assertContentDescriptionEquals("Name Ada")
      .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading))
      .assert(
        SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Assertive),
      )
      .assert(SemanticsMatcher.expectValue(SemanticsProperties.IsTraversalGroup, true))
      .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Image))
      .assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
      .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Extra guidance"))
  }

  @Test
  fun `search bar authored semantics belong to one editable node`() {
    val search =
      PrototypeSearchBarNode(
        testTag = "search",
        stateKey = "query",
        semantics = PrototypeSemantics(label = "Find items", hint = "Enter query", heading = true),
      )
    val model =
      mapPrototypeSpec(
        spec.copy(state = mapOf("query" to PrototypeScalar.Text("")), root = search),
      )
    compose.setContent { PrototypeSpecContent(model.root) {} }
    compose.onAllNodesWithTag("search").assertCountEquals(1)
    compose.onAllNodesWithTag("search", useUnmergedTree = true).assertCountEquals(1)
    compose
      .onNodeWithTag("search")
      .assertContentDescriptionEquals("Find items")
      .assert(SemanticsMatcher.expectValue(PrototypeRole, "searchBar"))
      .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading))
      .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Enter query"))
  }

  @Test
  fun `tap hint labels the action and label wins over derived text`() {
    val node =
      PrototypeTextNode(
        testTag = "button",
        text = "Derived",
        onTap = listOf(PrototypeEmitAction("go")),
        semantics =
          PrototypeSemantics(label = "Accessible", hint = "Activate", traits = listOf("button")),
      )
    compose.setContent { PrototypeSpecContent(mapPrototypeSpec(spec.copy(root = node)).root) {} }
    compose
      .onNodeWithTag("button")
      .assertContentDescriptionEquals("Accessible")
      .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
      .assert(
        SemanticsMatcher("click hint") {
          it.config[androidx.compose.ui.semantics.SemanticsActions.OnClick].label == "Activate"
        },
      )
  }
}
