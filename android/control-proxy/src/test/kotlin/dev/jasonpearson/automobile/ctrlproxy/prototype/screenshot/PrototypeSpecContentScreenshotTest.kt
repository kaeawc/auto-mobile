package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import android.app.Application
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import dev.jasonpearson.automobile.ctrlproxy.prototype.LocalPrototypeMenuLayers
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeMenuLayers
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeSpecContent
import dev.jasonpearson.automobile.ctrlproxy.prototype.RenderPrototypeSelect
import dev.jasonpearson.automobile.ctrlproxy.prototype.RenderPrototypeSelectOptions
import dev.jasonpearson.automobile.ctrlproxy.prototype.mapPrototypeSpec
import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.protocol.PrototypeCheck
import dev.jasonpearson.automobile.protocol.PrototypeColumnNode
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSliderNode
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
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
 * `control-proxy`, test filter `*Prototype*ScreenshotTest`, covering this class and
 * `PrototypeHostChromeScreenshotTest`); a case whose baseline is missing or stale is marked
 * `pending` until recorded.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-mdpi", application = Application::class)
class PrototypeSpecContentScreenshotTest {

  private companion object {
    val OPEN = JsonPrimitive(true)
    /** `theme-modes-colors` root child indices of its half and full bottom sheets. */
    const val HALF_SHEET = 1
    const val FULL_SHEET = 2
  }

  // Pending: #12066 textField trailing icon and IME action; no Linux baseline recorded yet.
  @Test
  fun textFieldActions() =
    prototypeScreenshotTest(
      "text_field_actions",
      validPrototypeFixture("text-field-actions"),
      pending = true,
    )

  // Pending: #12071 carousel and pager indicator cases; no Linux baselines recorded yet.
  @Test
  fun carouselMultiBrowse() =
    prototypeScreenshotTest(
      "carousel_multi_browse",
      validPrototypeFixture("carousel-multi-browse"),
      pending = true,
    )

  @Test
  fun carouselHeroRepeat() =
    prototypeScreenshotTest(
      "carousel_hero_repeat",
      validPrototypeFixture("carousel-hero-repeat"),
      pending = true,
    )

  @Test
  fun pagerIndicatorDots() =
    prototypeScreenshotTest(
      "pager_indicator_dots",
      validPrototypeFixture("pager-indicator-dots"),
      pending = true,
    )

  // Pending: #12065 swipe actions render closed; no Linux baseline recorded yet.
  @Test
  fun swipeActionsListItem() =
    prototypeScreenshotTest(
      "swipe_actions_list_item",
      validPrototypeFixture("swipe-actions-list-item"),
      pending = true,
    )

  @Test fun flowBasic() = prototypeScreenshotTest("flow_basic", validPrototypeFixture("flow-basic"))

  @Test
  fun flowMaxLinesRepeat() =
    prototypeScreenshotTest(
      "flow_max_lines_repeat",
      validPrototypeFixture("flow-max-lines-repeat"),
    )

  @Test
  fun gridFixedColumnsSpan() =
    prototypeScreenshotTest(
      "grid_fixed_columns_span",
      validPrototypeFixture("grid-fixed-columns-span"),
    )

  @Test
  fun gridAdaptiveMinWidth() =
    prototypeScreenshotTest(
      "grid_adaptive_min_width",
      validPrototypeFixture("grid-adaptive-min-width"),
    )

  // Pending until the Linux recording workflow produces these new pager-option baselines.
  @Test fun peekPager() = prototypeScreenshotTest("pager_peek", pagerOptionSpec(0), pending = true)

  @Test
  fun verticalPager() =
    prototypeScreenshotTest("pager_vertical", pagerOptionSpec(1), pending = true)

  private fun pagerOptionSpec(index: Int): PrototypeSpec {
    val spec = validPrototypeFixture("pager-options")
    val pager = (spec.root as PrototypeColumnNode).children[index] as PrototypePagerNode
    return spec.copy(
      root =
        pager.copy(
          style =
            PrototypeStyle(
              width = PrototypeDimension.Dp(300.0),
              height = PrototypeDimension.Dp(240.0),
            ),
        ),
    )
  }

  @Test
  @Config(qualifiers = "+notnight")
  fun inputChecksErrorsLight() = inputChecksErrors("input_checks_errors_light")

  @Test
  @Config(qualifiers = "+night")
  fun inputChecksErrorsDark() = inputChecksErrors("input_checks_errors_dark")

  private fun inputChecksErrors(name: String) =
    prototypeScreenshotTest(name, pending = true) {
      val fixture = validPrototypeFixture("checks-form")
      // Compact form fits the window and shows the field, checkbox and switch captions together.
      val root = fixture.root as PrototypeColumnNode
      val spec =
        fixture.copy(
          root =
            root.copy(
              children =
                root.children.take(5).map { node ->
                  if (node is PrototypeSliderNode)
                    node.copy(checks = listOf(PrototypeCheck.Min(10.0, "Choose at least ten")))
                  else node
                },
            ),
          state = fixture.state.orEmpty() + ("radioGroup" to PrototypeScalar.Text("")),
        )
      val model = mapPrototypeSpec(spec, shownErrors = spec.state.orEmpty().keys)
      renderComposable(name) { PrototypeSpecContent(model.root, theme = model.theme) }
    }

  // Pending: #11298 changed the image placeholder colours (surfaceVariant instead of LightGray), so
  // this baseline must be re-recorded by the Linux workflow described above.
  /** Every node type and style token in one fullscreen tree. */
  // Recorded by the Linux workflow; pending verification until its first golden is committed.
  @Test
  fun textFieldOptions() =
    prototypeScreenshotTest(
      "text_field_options",
      validPrototypeFixture("text-field-options"),
      pending = true,
    )

  @Test
  fun fullscreenAllNodes() =
    prototypeScreenshotTest(
      "fullscreen_all_nodes",
      validPrototypeFixture("fullscreen-all-nodes"),
    )

  // Pending: #11298 changed the image placeholder colours (surfaceVariant instead of LightGray), so
  // this baseline must be re-recorded by the Linux workflow described above.
  /** Tab bar, pager with a scrolled text page, text field and a closed bottom sheet. */
  @Test
  fun tabbedPagerWithTextField() =
    prototypeScreenshotTest("doc_example_1", validPrototypeFixture("doc-example-1"))

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
    prototypeScreenshotTest("material_controls", validPrototypeFixture("material-controls"))

  /** Slider, chips and a card. */
  @Test
  fun materialSliderChipCard() =
    prototypeScreenshotTest(
      "material_slider_chip_card",
      validPrototypeFixture("material-slider-chip-card"),
      pending = true,
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
    )

  /** Radio group, list items, checkbox, switch and icon buttons. */
  @Test
  fun selectionControls() =
    prototypeScreenshotTest("selection_controls", validPrototypeFixture("selection-controls"))

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
  // be re-recorded by the Linux workflow described above, then pending dropped.
  /** Text style roles under a scaled typography theme. */
  @Test
  fun textStyleRole() =
    prototypeScreenshotTest(
      "text_style_role",
      validPrototypeFixture("text-style-role"),
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
  @Test fun themeSeed() = prototypeScreenshotTest("theme_seed", validPrototypeFixture("theme-seed"))

  /** Light mode with scaled serif typography and custom shapes. */
  @Test
  fun themeTypographyShapes() =
    prototypeScreenshotTest(
      "theme_typography_shapes",
      validPrototypeFixture("theme-typography-shapes"),
    )

  /** A `system` theme on a light device. */
  @Test
  @Config(qualifiers = "+notnight")
  fun themeDeviceLight() =
    prototypeScreenshotTest(
      "theme_device_light",
      validPrototypeFixture("theme-device"),
    )

  // Theme fixtures over component content (#11217): the shared
  // theme-*.json fixtures are a single text node, so each theme is also drawn over a component
  // fixture.

  /** Dark seed scheme on buttons, checkbox and switch. */
  @Test
  fun themeSeedControls() =
    prototypeScreenshotTest(
      "theme_seed_controls",
      validPrototypeFixture("material-controls", themeFrom = "theme-seed"),
    )

  /** Dark seed scheme on a slider, chips and a card. */
  @Test
  fun themeSeedSliderChipCard() =
    prototypeScreenshotTest(
      "theme_seed_slider_chip_card",
      validPrototypeFixture("material-slider-chip-card", themeFrom = "theme-seed"),
    )

  /** Dark seed scheme on role-coloured boxes. */
  @Test
  fun themeSeedColorRoles() =
    prototypeScreenshotTest(
      "theme_seed_color_roles",
      validPrototypeFixture("color-role-and-corner-tokens", themeFrom = "theme-seed"),
    )

  /** Scaled serif type and large corners on buttons, checkbox and switch. */
  @Test
  fun themeTypographyShapesControls() =
    prototypeScreenshotTest(
      "theme_typography_shapes_controls",
      validPrototypeFixture("material-controls", themeFrom = "theme-typography-shapes"),
    )

  /** Scaled serif type and large corners on a slider, chips and a card. */
  @Test
  fun themeTypographyShapesSliderChipCard() =
    prototypeScreenshotTest(
      "theme_typography_shapes_slider_chip_card",
      validPrototypeFixture("material-slider-chip-card", themeFrom = "theme-typography-shapes"),
    )

  /** Device dynamic colour on components on a light device. */
  @Test
  @Config(qualifiers = "+notnight")
  fun themeDeviceControlsLight() =
    prototypeScreenshotTest(
      "theme_device_controls_light",
      validPrototypeFixture("material-controls", themeFrom = "theme-device"),
    )

  /** Device dynamic colour on components on a dark device. */
  @Test
  @Config(qualifiers = "+night")
  fun themeDeviceControlsDark() =
    prototypeScreenshotTest(
      "theme_device_controls_dark",
      validPrototypeFixture("material-controls", themeFrom = "theme-device"),
    )

  /** Flat role overrides with an explicit light mode. */
  @Test
  fun themeRoleOverrides() =
    prototypeScreenshotTest(
      "theme_role_overrides",
      validPrototypeFixture("theme-role-overrides"),
    )

  // Dark-mode gallery (#11217). The specs carry no theme, so the `+night` device decides. The
  // gallery's authored `#FF121212` root background would otherwise win (appearance is inferred from
  // a single authored background), so the gallery cases pair it with a light side (#14583, #14589).

  /** Every node type on a dark device; the unresolved image assets draw their placeholders. */
  @Test
  @Config(qualifiers = "+night")
  fun fullscreenAllNodesDark() =
    prototypeScreenshotTest(
      "fullscreen_all_nodes_dark",
      validPrototypeFixture("fullscreen-all-nodes", edit = ::withModeRootBackground),
    )

  /** A bottom sheet opened over the dark gallery: scrim, surface and drag handle. */
  @Test
  @Config(qualifiers = "+night")
  fun bottomSheetOpenDark() =
    prototypeScreenshotTest(
      "bottom_sheet_open_dark",
      validPrototypeFixture(
        "fullscreen-all-nodes",
        stateOverrides = mapOf("open" to OPEN),
        edit = ::withModeRootBackground,
      ),
    )

  /** The same open bottom sheet on a light device, for the scrim and handle contrast. */
  @Test
  @Config(qualifiers = "+notnight")
  fun bottomSheetOpenLight() =
    prototypeScreenshotTest(
      "bottom_sheet_open_light",
      validPrototypeFixture(
        "fullscreen-all-nodes",
        stateOverrides = mapOf("open" to OPEN),
        edit = ::withModeRootBackground,
      ),
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
    )

  /** The app bar, dialog and pickers fixture with nothing open, on a dark device. */
  @Test
  @Config(qualifiers = "+night")
  fun materialAppBarDialogPickersDark() =
    prototypeScreenshotTest(
      "material_app_bar_dialog_pickers_dark",
      validPrototypeFixture("material-app-bar-dialog-pickers"),
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
    )

  /** A `system` theme on a dark device. */
  @Test
  @Config(qualifiers = "+night")
  fun themeDeviceDark() =
    prototypeScreenshotTest(
      "theme_device_dark",
      validPrototypeFixture("theme-device"),
    )

  // Per-mode colours (#11219): `{light, dark}` pairs in a style colour, border, shadow and gradient
  // stop, role-named stops, and the `theme.colors.light` / `theme.colors.dark` maps. Pending until
  // recorded by the Linux workflow described above (#11319).

  /** The per-mode colour fixture on a light device: every pair draws its light side. */
  @Test
  @Config(qualifiers = "+notnight")
  fun themeModesColorsLight() =
    prototypeScreenshotTest(
      "theme_modes_colors_light",
      validPrototypeFixture("theme-modes-colors"),
    )

  /** The same fixture on a dark device: every pair draws its dark side. */
  @Test
  @Config(qualifiers = "+night")
  fun themeModesColorsDark() =
    prototypeScreenshotTest(
      "theme_modes_colors_dark",
      validPrototypeFixture("theme-modes-colors"),
    )

  // Both of the fixture's sheets open on the same `open` key and the full-height one, declared
  // last, covers the other, so each capture keeps one sheet (#14586). A `full` detent covers the
  // scrim too, so the role-scrim capture opens that sheet at `half`.

  /** Its half sheet open on a light device: the `styleWhen` pair and the pair scrim. */
  @Test
  @Config(qualifiers = "+notnight")
  fun themeModesColorsOpenLight() =
    themeModesColorsOpen("theme_modes_colors_open_light", FULL_SHEET)

  /** Its half sheet open on a dark device. */
  @Test
  @Config(qualifiers = "+night")
  fun themeModesColorsOpenDark() = themeModesColorsOpen("theme_modes_colors_open_dark", FULL_SHEET)

  /** Its role-scrim sheet open at half height on a light device: the `scrim` role scrim. */
  @Test
  @Config(qualifiers = "+notnight")
  fun themeModesColorsFullSheetOpenLight() =
    themeModesColorsOpen("theme_modes_colors_role_scrim_open_light", HALF_SHEET)

  /** Its role-scrim sheet open at half height on a dark device. */
  @Test
  @Config(qualifiers = "+night")
  fun themeModesColorsFullSheetOpenDark() =
    themeModesColorsOpen("theme_modes_colors_role_scrim_open_dark", HALF_SHEET)

  private fun themeModesColorsOpen(name: String, droppedSheet: Int) =
    prototypeScreenshotTest(
      name,
      validPrototypeFixture(
        "theme-modes-colors",
        stateOverrides = mapOf("open" to OPEN),
        edit = { spec -> halfDetents(withoutRootChild(droppedSheet)(spec)) },
      ),
    )

  /** Opens every remaining root bottom sheet at `half`, so its scrim shows above it. */
  private fun halfDetents(spec: JsonObject): JsonObject {
    val root = spec["root"] as JsonObject
    val children =
      (root["children"] as JsonArray).map { child ->
        val node = child as JsonObject
        if ((node["type"] as? JsonPrimitive)?.content == "bottomSheet")
          JsonObject(node + ("detents" to JsonArray(listOf(JsonPrimitive("half")))))
        else node
      }
    return JsonObject(spec + ("root" to JsonObject(root + ("children" to JsonArray(children)))))
  }

  // Pending: #14207 skeleton rows with shimmer, static under the screenshot's motion off; no
  // Linux baseline recorded yet.
  @Test
  fun loadingStatesSkeleton() =
    prototypeScreenshotTest(
      "loading_states_skeleton",
      validPrototypeFixture("loading-states"),
      pending = true,
    )

  @Test
  fun stylePolishV2() =
    prototypeScreenshotTest(
      "style_polish_v2",
      validPrototypeFixture("style-polish-v2"),
      pending = true,
    )

  @Test
  @Config(qualifiers = "+night")
  fun stylePolishV2Dark() =
    prototypeScreenshotTest(
      "style_polish_v2_dark",
      validPrototypeFixture("style-polish-v2"),
      pending = true,
    )

  // Pending: #14208 scale, rotation and colour applied by styleWhen, settled (no motion in
  // screenshots); no Linux baseline recorded yet.
  @Test
  fun motionV2Liked() =
    prototypeScreenshotTest(
      "motion_v2_liked",
      validPrototypeFixture(
        "motion-v2",
        stateOverrides = mapOf("liked" to OPEN, "drawer" to OPEN),
      ),
      pending = true,
    )

  // Pending: #14209 line, area, bar and ring charts; no Linux baselines recorded yet.
  @Test
  fun chartVariants() =
    prototypeScreenshotTest(
      "chart_variants",
      validPrototypeFixture("chart-variants"),
      pending = true,
    )

  @Test
  @Config(qualifiers = "+night")
  fun chartVariantsDark() =
    prototypeScreenshotTest(
      "chart_variants_dark",
      validPrototypeFixture("chart-variants"),
      pending = true,
    )

  /** Pending until the baseline workflow records the new menu and select surfaces. */
  @Test
  fun menuOpen() =
    prototypeScreenshotTest(
      "menu_open",
      validPrototypeFixture("menu-overflow", stateOverrides = mapOf("open" to OPEN)),
      pending = true,
    )

  @Test
  fun selectCollapsed() =
    prototypeScreenshotTest(
      "select_collapsed",
      validPrototypeFixture("select-dropdown"),
      pending = true,
    )

  @Test
  fun selectExpanded() =
    prototypeScreenshotTest("select_expanded", pending = true) {
      val root = mapPrototypeSpec(validPrototypeFixture("select-dropdown")).root
      val node = root.children.first()
      renderComposable("select_expanded") {
        val layers = remember { PrototypeMenuLayers().apply { expandedSelect = node.identity } }
        CompositionLocalProvider(LocalPrototypeMenuLayers provides layers) {
          Box(
            Modifier.fillMaxSize().onGloballyPositioned { layers.windowBounds = it.boundsInRoot() },
          ) {
            RenderPrototypeSelect(node, Modifier)
            RenderPrototypeSelectOptions(node) {}
          }
        }
      }
    }
}
