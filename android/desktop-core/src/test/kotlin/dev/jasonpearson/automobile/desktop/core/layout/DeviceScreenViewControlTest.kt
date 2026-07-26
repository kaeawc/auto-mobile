package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.click
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode
import dev.jasonpearson.automobile.desktop.domain.ElementBounds
import dev.jasonpearson.automobile.desktop.domain.UIElementInfo
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * View-level routing coverage for issue #3347: a click in [DeviceScreenControlMode.Control] is
 * reported to `onControlTap` (and never selects an element), while a click in the default
 * [DeviceScreenControlMode.Inspector] still selects an element and reports no control tap. Neither
 * path sends daemon input from the view itself — the control tap is only a reported coordinate.
 * Renders the real view with fakes; no device or daemon.
 */
@OptIn(ExperimentalTestApi::class)
class DeviceScreenViewControlTest {

  private val root =
    UIElementInfo(
      id = "root",
      className = "android.widget.FrameLayout",
      resourceId = null,
      text = null,
      contentDescription = null,
      bounds = ElementBounds(0, 0, 1080, 2340),
      isClickable = false,
      isEnabled = true,
      isFocused = false,
      isSelected = false,
      isScrollable = false,
      isCheckable = false,
      isChecked = false,
      depth = 0,
      children = emptyList(),
    )

  @Test
  fun `control-mode click reports a device tap and does not select`() = runComposeUiTest {
    val controlTaps = mutableListOf<DevicePoint>()
    val selections = mutableListOf<String?>()

    setContent {
      MaterialTheme {
        DeviceScreenView(
          screenshotData = null,
          screenWidth = 1080,
          screenHeight = 2340,
          hierarchy = root,
          selectedElementId = null,
          hoveredElementId = null,
          onElementSelected = { selections.add(it) },
          onElementHovered = {},
          elementMap = mapOf("root" to root),
          controlMode = DeviceScreenControlMode.Control,
          onControlTap = { controlTaps.add(it) },
        )
      }
    }

    onRoot().performTouchInput { click() }
    waitForIdle()

    assertEquals(1, controlTaps.size, "control click should report exactly one tap")
    assertTrue(controlTaps.single().inBounds, "a center click maps inside the device screen")
    // Control mode suppresses selection: the only selection callbacks are the null clears the mode
    // entry emits, never a selected element id.
    assertTrue(
      selections.all { it == null },
      "control mode must not select an element (got $selections)",
    )
  }

  @Test
  fun `inspector-mode click still selects an element and reports no control tap`() =
    runComposeUiTest {
      val controlTaps = mutableListOf<DevicePoint>()
      val selections = mutableListOf<String?>()

      setContent {
        MaterialTheme {
          DeviceScreenView(
            screenshotData = null,
            screenWidth = 1080,
            screenHeight = 2340,
            hierarchy = root,
            selectedElementId = null,
            hoveredElementId = null,
            onElementSelected = { selections.add(it) },
            onElementHovered = {},
            elementMap = mapOf("root" to root),
            // controlMode defaults to Inspector; onControlTap is wired only to prove it stays
            // inert.
            onControlTap = { controlTaps.add(it) },
          )
        }
      }

      onRoot().performTouchInput { click() }
      waitForIdle()

      assertTrue(controlTaps.isEmpty(), "inspector mode must not report a control tap")
      assertNotNull(
        selections.lastOrNull { it != null },
        "inspector click over the root should select it",
      )
      assertEquals("root", selections.last())
    }
}
