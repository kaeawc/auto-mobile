package dev.jasonpearson.automobile.ctrlproxy.overlay.screenshot

import android.app.Application
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renderer snapshot tests for [dev.jasonpearson.automobile.ctrlproxy.overlay.OverlaySpecContent]
 * over the shared, validator-checked specs in `test/fixtures/overlay-spec/valid` (issue #10445).
 * Each renders off-device on the JVM and compares against a baseline in
 * `control-proxy/src/test/resources/screenshots/overlay/`, recorded on the Linux reference OS.
 *
 * Baselines are recorded with the `Record Desktop Screenshot Baselines` workflow (module
 * `control-proxy`); until then each test is `pending = true`.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-mdpi", application = Application::class)
class OverlaySpecContentScreenshotTest {

  /** Every node type and style token in one fullscreen tree. */
  @Test
  fun fullscreenAllNodes() =
    overlayScreenshotTest(
      "fullscreen_all_nodes",
      validOverlayFixture("fullscreen-all-nodes"),
    )

  /** Tab bar, pager with a scrolled text page, text field and a closed bottom sheet. */
  @Test
  fun tabbedPagerWithTextField() =
    overlayScreenshotTest("doc_example_1", validOverlayFixture("doc-example-1"))

  /** Horizontal scroll row with an icon action above a bottom navigation bar. */
  @Test
  fun bottomNavigationSheet() =
    overlayScreenshotTest("doc_example_2", validOverlayFixture("doc-example-2"))

  /** Styled floating box: background colour, corner radius and a text child. */
  @Test
  fun styledFloatingBox() =
    overlayScreenshotTest(
      "doc_example_3",
      validOverlayFixture("doc-example-3", resolveElementAnchors = true),
    )

  /** Tab bar and bottom navigation bound to state and to a pager. */
  @Test
  fun sheetBindings() =
    overlayScreenshotTest("sheet_bindings", validOverlayFixture("sheet-bindings"))

  /** Buttons, checkbox and switch in a row and column layout. */
  @Test
  fun materialControls() =
    overlayScreenshotTest(
      "material_controls",
      validOverlayFixture("material-controls"),
    )

  /** Slider, chips and a card. */
  @Test
  fun materialSliderChipCard() =
    overlayScreenshotTest(
      "material_slider_chip_card",
      validOverlayFixture("material-slider-chip-card"),
    )

  /** Radio group, list items, checkbox, switch and icon buttons. */
  @Test
  fun selectionControls() =
    overlayScreenshotTest(
      "selection_controls",
      validOverlayFixture("selection-controls"),
    )

  /** Colour-role and corner-radius style tokens. */
  @Test
  fun colorRoleAndCornerTokens() =
    overlayScreenshotTest(
      "color_role_and_corner_tokens",
      validOverlayFixture("color-role-and-corner-tokens"),
    )

  /** Elevation, linear and radial gradients, and aspect ratio. */
  @Test
  fun elevationGradientAspectRatio() =
    overlayScreenshotTest(
      "elevation_gradient_aspect_ratio",
      validOverlayFixture("elevation-gradient-aspect-ratio"),
    )

  /** Text style roles under a scaled typography theme. */
  @Test
  fun textStyleRole() =
    overlayScreenshotTest("text_style_role", validOverlayFixture("text-style-role"))

  /** Conditional styles resolved against the initial state. */
  @Test fun styleWhen() = overlayScreenshotTest("style_when", validOverlayFixture("style-when"))

  /**
   * Top app bar, icon button, FAB, segmented button, badge, progress, dialog, snackbar and pickers.
   */
  @Test
  fun materialAppBarDialogPickers() =
    overlayScreenshotTest(
      "material_app_bar_dialog_pickers",
      validOverlayFixture("material-app-bar-dialog-pickers"),
    )

  /** Shadow colour, offset, per-corner radii and the text polish styles (#10441). */
  @Test
  fun stylePolish() = overlayScreenshotTest("style_polish", validOverlayFixture("style-polish"))

  /** Component labels, titles and button actions bound from repeat items. */
  @Test
  fun repeatComponentLabels() =
    overlayScreenshotTest(
      "repeat_component_labels",
      validOverlayFixture("repeat-component-labels"),
    )

  /** A list template expanded with repeat. */
  @Test fun repeatTemplate() = overlayScreenshotTest("repeat", validOverlayFixture("repeat"))

  /** Row weights and size bounds. */
  @Test
  fun rowWeightSizeBounds() =
    overlayScreenshotTest(
      "row_weight_size_bounds",
      validOverlayFixture("row-weight-size-bounds"),
    )

  /** Dark mode with a seed colour scheme. */
  @Test fun themeSeed() = overlayScreenshotTest("theme_seed", validOverlayFixture("theme-seed"))

  /** Light mode with scaled serif typography and custom shapes. */
  @Test
  fun themeTypographyShapes() =
    overlayScreenshotTest(
      "theme_typography_shapes",
      validOverlayFixture("theme-typography-shapes"),
    )

  /** A `system` theme on a light device. */
  @Test
  @Config(qualifiers = "+notnight")
  fun themeDeviceLight() =
    overlayScreenshotTest(
      "theme_device_light",
      validOverlayFixture("theme-device"),
    )

  /** A `system` theme on a dark device. */
  @Test
  @Config(qualifiers = "+night")
  fun themeDeviceDark() =
    overlayScreenshotTest(
      "theme_device_dark",
      validOverlayFixture("theme-device"),
    )
}
