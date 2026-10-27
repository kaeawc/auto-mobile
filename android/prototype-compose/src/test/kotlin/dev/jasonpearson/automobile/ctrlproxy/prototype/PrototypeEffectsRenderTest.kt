package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.prototype.fixtureFile
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Renders the shared effect fixtures at several API levels (#15129). Effects are paint only: the
 * nodes keep their text and bounds whether an effect is drawn, falls back or is absent.
 */
@RunWith(RobolectricTestRunner::class)
class PrototypeEffectsRenderTest {
  @get:Rule val compose = createComposeRule()

  private fun spec(text: String): PrototypeSpec =
    when (val result = PrototypeSpecValidator.validate(text)) {
      is PrototypeSpecValidation.Success -> result.spec
      is PrototypeSpecValidation.Failure -> error("${result.error}")
    }

  private fun withoutEffects(element: JsonElement): JsonElement =
    when (element) {
      is JsonObject ->
        JsonObject(element.filterKeys { it != "effects" }.mapValues { withoutEffects(it.value) })
      is JsonArray -> JsonArray(element.map(::withoutEffects))
      else -> element
    }

  private val groups = listOf("Group 0", "Group 1", "Group 2", "Group 3")

  private var sdk by mutableIntStateOf(33)
  private var root: PrototypeRenderNode? by mutableStateOf(null)

  private fun show(spec: PrototypeSpec, sdk: Int) {
    this.sdk = sdk
    root = mapPrototypeSpec(spec).root
    compose.waitForIdle()
  }

  private fun bounds() = groups.map { compose.onNodeWithText(it).getBoundsInRoot() }

  @Test
  fun `every effect fixture renders at API 30, 31 and 33 and keeps its bounds`() {
    val text = fixtureFile("prototype-spec/valid/z-effects-all-types.json").readText()
    val plain =
      spec(
        withoutEffects(kotlinx.serialization.json.Json.parseToJsonElement(text)).toString(),
      )
    compose.setContent {
      val shown = root
      if (shown != null) {
        CompositionLocalProvider(LocalPrototypeEffectSdk provides sdk) {
          PrototypeSpecContent(shown) {}
        }
      }
    }
    show(plain, 33)
    val expected = bounds()
    for (level in listOf(30, 31, 33)) {
      show(spec(text), level)
      assertEquals("sdk $level", expected, bounds())
    }
  }
}
