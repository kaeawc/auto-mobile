package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import android.app.Application
import kotlinx.serialization.json.JsonPrimitive
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

  private companion object {
    val OPEN = JsonPrimitive(true)
  }

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

  // Dark-mode gallery (#11217). The specs carry no theme, so the `+night` device decides; every
  // case is pending until recorded on Linux from an LFS-enabled plain-git clone.

  /** Every node type on a dark device; the unresolved image assets draw their placeholders. */
  @Test
  @Config(qualifiers = "+night")
  fun fullscreenAllNodesDark() =
    prototypeScreenshotTest(
      "fullscreen_all_nodes_dark",
      validPrototypeFixture("fullscreen-all-nodes"),
      pending = true,
    )

  /** A bottom sheet opened over the dark gallery: scrim, surface and drag handle. */
  @Test
  @Config(qualifiers = "+night")
  fun bottomSheetOpenDark() =
    prototypeScreenshotTest(
      "bottom_sheet_open_dark",
      validPrototypeFixture("fullscreen-all-nodes", stateOverrides = mapOf("open" to OPEN)),
      pending = true,
    )

  /** The same open bottom sheet on a light device, for the scrim and handle contrast. */
  @Test
  @Config(qualifiers = "+notnight")
  fun bottomSheetOpenLight() =
    prototypeScreenshotTest(
      "bottom_sheet_open_light",
      validPrototypeFixture("fullscreen-all-nodes", stateOverrides = mapOf("open" to OPEN)),
      pending = true,
    )

  /** An alarm dialog opened over the dark gallery: scrim and dialog surface. */
  @Test
  @Config(qualifiers = "+night")
  fun dialogOpenDark() =
    prototypeScreenshotTest(
      "dialog_open_dark",
      validPrototypeFixture(
        "material-app-bar-dialog-pickers",
        stateOverrides = mapOf("editing" to OPEN),
      ),
      pending = true,
    )

  /** The app bar, dialog and pickers fixture with nothing open, on a dark device. */
  @Test
  @Config(qualifiers = "+night")
  fun materialAppBarDialogPickersDark() =
    prototypeScreenshotTest(
      "material_app_bar_dialog_pickers_dark",
      validPrototypeFixture("material-app-bar-dialog-pickers"),
      pending = true,
    )

  /**
   * A spec with no theme and an authored dark background (`#112233`) on a light device: the
   * renderer infers dark content colours from the background.
   */
  @Test
  @Config(qualifiers = "+notnight")
  fun styleWhenInferredDark() =
    prototypeScreenshotTest(
      "style_when_inferred_dark",
      validPrototypeFixture("style-when"),
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
