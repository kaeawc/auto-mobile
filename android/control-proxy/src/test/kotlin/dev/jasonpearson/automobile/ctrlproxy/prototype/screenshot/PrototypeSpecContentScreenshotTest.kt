package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import android.app.Application
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renderer snapshot tests for
 * [dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeSpecContent] over the shared,
 * validator-checked specs in `test/fixtures/prototype-spec/valid` (issue #10445). Each renders
 * off-device on the JVM and compares against a baseline in
 * `control-proxy/src/test/resources/screenshots/prototype/`, recorded on the Linux reference OS.
 *
 * Baselines are recorded with the `Record Desktop Screenshot Baselines` workflow (module
 * `control-proxy`); until then each test is `pending = true`.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-mdpi", application = Application::class)
class PrototypeSpecContentScreenshotTest {

  // Pending: #11298 changed the image placeholder colours (surfaceVariant instead of LightGray), so
  // this baseline must be re-recorded on Linux from an LFS-enabled plain-git clone.
  /** Every node type and style token in one fullscreen tree. */
  @Test
  fun fullscreenAllNodes() =
    prototypeScreenshotTest(
      "fullscreen_all_nodes",
      validPrototypeFixture("fullscreen-all-nodes"),
      pending = true,
    )

  // Pending: #11298 changed the image placeholder colours (surfaceVariant instead of LightGray), so
  // this baseline must be re-recorded on Linux from an LFS-enabled plain-git clone.
  /** Tab bar, pager with a scrolled text page, text field and a closed bottom sheet. */
  @Test
  fun tabbedPagerWithTextField() =
    prototypeScreenshotTest("doc_example_1", validPrototypeFixture("doc-example-1"), pending = true)

  /** Horizontal scroll row with an icon action above a bottom navigation bar. */
  @Test
  fun bottomNavigationSheet() =
    prototypeScreenshotTest("doc_example_2", validPrototypeFixture("doc-example-2"))

  /** Styled floating box: background colour, corner radius and a text child. */
  @Test
  fun styledFloatingBox() =
    prototypeScreenshotTest(
      "doc_example_3",
      validPrototypeFixture("doc-example-3", resolveElementAnchors = true),
    )

  /** Tab bar and bottom navigation bound to state and to a pager. */
  @Test
  fun sheetBindings() =
    prototypeScreenshotTest("sheet_bindings", validPrototypeFixture("sheet-bindings"))

  /** Buttons, checkbox and switch in a row and column layout. */
  @Test
  fun materialControls() =
    prototypeScreenshotTest(
      "material_controls",
      validPrototypeFixture("material-controls"),
    )

  /** Slider, chips and a card. */
  @Test
  fun materialSliderChipCard() =
    prototypeScreenshotTest(
      "material_slider_chip_card",
      validPrototypeFixture("material-slider-chip-card"),
    )

  /**
   * Repeated like rows whose toggle, style and visibility keys bind `liked_{item.id}` (#11051): the
   * first row unliked and the second liked, so one capture covers both states.
   */
  @Test
  fun repeatStateKeys() =
    prototypeScreenshotTest(
      "repeat_state_keys",
      validPrototypeFixture("repeat-state-keys"),
      pending = true,
    )

  /** Radio group, list items, checkbox, switch and icon buttons. */
  @Test
  fun selectionControls() =
    prototypeScreenshotTest(
      "selection_controls",
      validPrototypeFixture("selection-controls"),
    )

  /** Colour-role and corner-radius style tokens. */
  @Test
  fun colorRoleAndCornerTokens() =
    prototypeScreenshotTest(
      "color_role_and_corner_tokens",
      validPrototypeFixture("color-role-and-corner-tokens"),
    )

  /** Elevation, linear and radial gradients, and aspect ratio. */
  @Test
  fun elevationGradientAspectRatio() =
    prototypeScreenshotTest(
      "elevation_gradient_aspect_ratio",
      validPrototypeFixture("elevation-gradient-aspect-ratio"),
    )

  // Pending: renderPrototype now honours spec.theme (#11217), so the theme-bearing baselines must
  // be
  // re-recorded on Linux from an LFS-enabled plain-git clone, then pending dropped.
  /** Text style roles under a scaled typography theme. */
  @Test
  fun textStyleRole() =
    prototypeScreenshotTest(
      "text_style_role",
      validPrototypeFixture("text-style-role"),
      pending = true,
    )

  /** Conditional styles resolved against the initial state. */
  @Test fun styleWhen() = prototypeScreenshotTest("style_when", validPrototypeFixture("style-when"))

  /**
   * Top app bar, icon button, FAB, segmented button, badge, progress, dialog, snackbar and pickers.
   */
  @Test
  fun materialAppBarDialogPickers() =
    prototypeScreenshotTest(
      "material_app_bar_dialog_pickers",
      validPrototypeFixture("material-app-bar-dialog-pickers"),
    )

  /** Shadow colour, offset, per-corner radii and the text polish styles (#10441). */
  @Test
  fun stylePolish() = prototypeScreenshotTest("style_polish", validPrototypeFixture("style-polish"))

  /** Component labels, titles and button actions bound from repeat items. */
  @Test
  fun repeatComponentLabels() =
    prototypeScreenshotTest(
      "repeat_component_labels",
      validPrototypeFixture("repeat-component-labels"),
    )

  /** A list template expanded with repeat. */
  @Test fun repeatTemplate() = prototypeScreenshotTest("repeat", validPrototypeFixture("repeat"))

  /** Row weights and size bounds. */
  @Test
  fun rowWeightSizeBounds() =
    prototypeScreenshotTest(
      "row_weight_size_bounds",
      validPrototypeFixture("row-weight-size-bounds"),
    )

  /** Dark mode with a seed colour scheme. */
  @Test
  fun themeSeed() =
    prototypeScreenshotTest("theme_seed", validPrototypeFixture("theme-seed"), pending = true)

  /** Light mode with scaled serif typography and custom shapes. */
  @Test
  fun themeTypographyShapes() =
    prototypeScreenshotTest(
      "theme_typography_shapes",
      validPrototypeFixture("theme-typography-shapes"),
      pending = true,
    )

  /** A `system` theme on a light device. */
  @Test
  @Config(qualifiers = "+notnight")
  fun themeDeviceLight() =
    prototypeScreenshotTest(
      "theme_device_light",
      validPrototypeFixture("theme-device"),
      pending = true,
    )

  /** A `system` theme on a dark device. */
  @Test
  @Config(qualifiers = "+night")
  fun themeDeviceDark() =
    prototypeScreenshotTest(
      "theme_device_dark",
      validPrototypeFixture("theme-device"),
      pending = true,
    )
}
