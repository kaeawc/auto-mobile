package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.pm.PackageManager
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "mdpi")
class PrototypeButtonFocusTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun `TV buttons move directional focus show a ring and activate from the keyboard`() {
    shadowOf(RuntimeEnvironment.getApplication().packageManager)
      .setSystemFeature(PackageManager.FEATURE_LEANBACK, true)
    lateinit var focus: FocusManager
    lateinit var inputMode: InputModeManager
    val taps = mutableListOf<PrototypeInteraction>()
    val buttons =
      listOf("filled", "tonal", "elevated", "outlined", "text").map { variant ->
        mapPrototypeSpec(
            PrototypeSpec(
              variant,
              PrototypeWindow(PrototypeFullscreenPlacement()),
              emptyMap(),
              PrototypeButtonNode(
                label = variant,
                variant = variant,
                onTap = listOf(PrototypeEmitAction(variant)),
              ),
            ),
          )
          .root
      }
    compose.setContent {
      focus = LocalFocusManager.current
      inputMode = LocalInputModeManager.current
      MaterialTheme {
        Column {
          buttons.forEach { button ->
            RenderPrototypeButton(button, Modifier.testTag(button.text)) { taps += it }
          }
        }
      }
    }
    compose.runOnIdle { inputMode.requestInputMode(InputMode.Keyboard) }
    compose.onNodeWithTag("filled").performSemanticsAction(SemanticsActions.RequestFocus)
    buttons.forEachIndexed { index, button ->
      val target = compose.onNodeWithTag(button.text)
      target.assertIsFocused().assertHasClickAction()
      assertFocusRing(target)
      target.performKeyInput { pressKey(Key.Enter) }
      assertEquals(PrototypeInteraction.Tap(listOf(PrototypeEmitAction(button.text))), taps.last())
      if (index < buttons.lastIndex) {
        compose.runOnIdle { assertTrue(focus.moveFocus(FocusDirection.Down)) }
        target.assertIsNotFocused()
      }
    }
    assertEquals(buttons.size, taps.size)
  }

  private fun assertFocusRing(target: SemanticsNodeInteraction) {
    // Material's minimum touch target can extend beyond its button semantics bounds.
    val bounds = target.fetchSemanticsNode().boundsInRoot
    val pixels = compose.onRoot().captureToImage().toPixelMap()
    val edge =
      ((bounds.top.toInt() - 8).coerceAtLeast(0)..bounds.top.toInt() + 4).map { y ->
        pixels[bounds.center.x.toInt(), y]
      }
    assertTrue(
      "Focused button has a white outline: $edge",
      edge.any { it.red > 0.9f && it.green > 0.9f && it.blue > 0.9f },
    )
    assertTrue(
      "Focused button has a black outline: $edge",
      edge.any { it.red < 0.1f && it.green < 0.1f && it.blue < 0.1f },
    )
  }
}
