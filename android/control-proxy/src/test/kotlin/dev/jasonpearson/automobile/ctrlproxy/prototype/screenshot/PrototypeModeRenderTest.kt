package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import android.app.Application
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.ctrlproxy.prototype.LocalPrototypeImageCache
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetChangeListener
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetInfo
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetSource
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImageCache
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImageDecoder
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeInsetFloor
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeSpecContent
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeTheme
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeWindowContent
import dev.jasonpearson.automobile.ctrlproxy.prototype.mapPrototypeSpec
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeAuthoredForeground
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeShownThemeFlow
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The renderer draws the `{light, dark}` forms, role-named gradient stops and scrims, the
 * `theme.colors.light` / `theme.colors.dark` maps and per-mode image assets for the prototype's
 * resolved mode (#11219). Samples drawn pixels rather than comparing baselines, so it runs on any
 * OS.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = Application::class, qualifiers = "w360dp-h640dp-mdpi")
class PrototypeModeRenderTest {
  private companion object {
    const val RED = 0xFFFF0000.toInt()
    const val BLUE = 0xFF0000FF.toInt()
    const val GREEN = 0xFF00FF00.toInt()
    const val MAGENTA = 0xFFFF00FF.toInt()
    const val HALF_RED = 0x80FF0000.toInt()
    // The `scrim` role at the default scrim opacity (0.4 is alpha 0x66).
    const val DIM_GREEN = 0x6600FF00
    const val DIM_MAGENTA = 0x66FF00FF
    const val FILL = """"width":"fill","height":"fill""""
    const val PAIR = """{"light":"#FF0000","dark":"#0000FF"}"""
    const val FULLSCREEN = """"window":{"placement":{"type":"fullscreen"}}"""
  }

  private fun spec(json: String): PrototypeSpec {
    val validation = PrototypeSpecValidator.validate(json)
    check(validation is PrototypeSpecValidation.Success) { "$validation" }
    return validation.spec
  }

  private fun theme(mode: String?) = mode?.let { """"theme":{"mode":"$it"},""" }.orEmpty()

  private fun PrototypeScreenshotComparator.Image.at(xFraction: Double, yFraction: Double): Int =
    pixels[(height * yFraction).toInt() * width + (width * xFraction).toInt()]

  private fun backgroundPair(mode: String? = null) =
    spec(
      """{"id":"p",$FULLSCREEN,${theme(mode)}
        "root":{"type":"box","style":{$FILL,"background":$PAIR},"children":[]}}""",
    )

  @Test
  @Config(qualifiers = "+notnight")
  fun backgroundPairDrawsItsLightValueOnALightDevice() {
    assertEquals(RED, renderPrototype("light", backgroundPair()).at(0.5, 0.5))
  }

  @Test
  @Config(qualifiers = "+night")
  fun backgroundPairDrawsItsDarkValueOnADarkDevice() {
    assertEquals(BLUE, renderPrototype("dark", backgroundPair()).at(0.5, 0.5))
  }

  @Test
  @Config(qualifiers = "+notnight")
  fun explicitModeWinsOverTheDeviceSetting() {
    assertEquals(BLUE, renderPrototype("dark", backgroundPair("dark")).at(0.5, 0.5))
    assertEquals(RED, renderPrototype("light", backgroundPair("light")).at(0.5, 0.5))
    assertEquals(RED, renderPrototype("system", backgroundPair("system")).at(0.5, 0.5))
  }

  @Test
  @Config(qualifiers = "+notnight")
  fun aRolePairFollowsTheModeChosenByAnAuthoredHexBackground() {
    // No theme: the opaque dark hex background infers dark, so the child pair draws its dark side.
    val inferred =
      spec(
        """{"id":"p",$FULLSCREEN,
          "root":{"type":"box","style":{$FILL,"background":"#101010"},"children":[
            {"type":"box","style":{$FILL,"background":$PAIR},"children":[]}]}}""",
      )
    assertEquals(BLUE, renderPrototype("inferred", inferred).at(0.5, 0.5))
  }

  /** Hard stops, so each half is one flat colour: a role stop, then a pair stop. */
  private fun gradient(mode: String) =
    spec(
      """{"id":"p",$FULLSCREEN,
        "theme":{"mode":"$mode","colors":{"primary":"#000000",
          "light":{"primary":"#00FF00"},"dark":{"primary":"#FF00FF"}}},
        "root":{"type":"box","style":{$FILL,"gradient":{"type":"linear","angle":0,"stops":[
          {"color":"primary","position":0},{"color":"primary","position":0.5},
          {"color":$PAIR,"position":0.5},{"color":$PAIR,"position":1}]}},"children":[]}}""",
    )

  @Test
  fun gradientStopsDrawRolesFromTheModeMapAndPairsForTheMode() {
    val light = renderPrototype("gradient-light", gradient("light"))
    assertEquals(GREEN, light.at(0.25, 0.5))
    assertEquals(RED, light.at(0.75, 0.5))
    val dark = renderPrototype("gradient-dark", gradient("dark"))
    assertEquals(MAGENTA, dark.at(0.25, 0.5))
    assertEquals(BLUE, dark.at(0.75, 0.5))
  }

  private fun styleSlots(mode: String) =
    spec(
      """{"id":"p",$FULLSCREEN,"theme":{"mode":"$mode"},
        "root":{"type":"box","style":{$FILL,"border":{"width":40,"color":$PAIR}},"children":[
          {"type":"card","style":{$FILL,"background":{"light":"#00FF00","dark":"#FF00FF"}},
            "children":[]}]}}""",
    )

  @Test
  fun borderAndComponentContainerPairsDrawForTheMode() {
    val light = renderPrototype("slots-light", styleSlots("light"))
    assertEquals(RED, light.at(0.5, 0.01))
    assertEquals(GREEN, light.at(0.5, 0.5))
    val dark = renderPrototype("slots-dark", styleSlots("dark"))
    assertEquals(BLUE, dark.at(0.5, 0.01))
    assertEquals(MAGENTA, dark.at(0.5, 0.5))
  }

  /** Role overrides that differ by mode, so a drawn role names its mode. */
  private fun roleTheme(mode: String) =
    """"theme":{"mode":"$mode","colors":{
      "light":{"scrim":"#00FF00","primary":"#00FF00"},
      "dark":{"scrim":"#FF00FF","primary":"#FF00FF"}}}"""

  private fun sheet(mode: String, scrim: String?) =
    spec(
      """{"id":"p",$FULLSCREEN,"state":{"open":true},${roleTheme(mode)},
        "root":{"type":"box","style":{$FILL},"children":[
          {"type":"bottomSheet","openWhen":{"key":"open","equals":true},"detents":["half"],
            ${scrim?.let { """"scrim":$it,""" }.orEmpty()}"child":{"type":"spacer"}}]}}""",
    )

  private fun sheetScrim(mode: String, scrim: String?) =
    renderPrototype("sheet-$mode", sheet(mode, scrim)).at(0.5, 0.1)

  @Test
  fun bottomSheetScrimDrawsPairsAndOtherRolesUnchanged() {
    assertEquals(RED, sheetScrim("light", PAIR))
    assertEquals(BLUE, sheetScrim("dark", PAIR))
    assertEquals(GREEN, sheetScrim("light", "\"primary\""))
    assertEquals(MAGENTA, sheetScrim("dark", "\"primary\""))
    assertEquals(HALF_RED, sheetScrim("dark", "\"#80FF0000\""))
  }

  @Test
  fun bottomSheetScrimRoleDrawsAtTheDefaultScrimOpacity() {
    assertEquals(DIM_GREEN, sheetScrim("light", "\"scrim\""))
    assertEquals(DIM_MAGENTA, sheetScrim("dark", "\"scrim\""))
    assertEquals(
      "the unauthored default",
      sheetScrim("dark", null),
      sheetScrim("dark", "\"scrim\""),
    )
    assertEquals(DIM_MAGENTA, sheetScrim("dark", """{"light":"#FF0000","dark":"scrim"}"""))
    assertEquals(RED, sheetScrim("light", """{"light":"#FF0000","dark":"scrim"}"""))
  }

  /** The window scrim is host chrome, drawn by `PrototypeWindowContent` behind the spec. */
  private fun windowScrim(mode: String, scrim: String): Int {
    val model =
      mapPrototypeSpec(
        spec(
          """{"id":"p","window":{"placement":{"type":"fullscreen","scrim":$scrim}},
            ${roleTheme(mode)},"root":{"type":"spacer"}}""",
        ),
      )
    // The controller hands the host the spec's root and theme the same way.
    val request = model.request().copy(theme = prototypeShownThemeFlow(model))
    return renderComposable("scrim-$mode") {
        PrototypeWindowContent(request) { PrototypeInsetFloor.None }
      }
      .at(0.5, 0.9)
  }

  /**
   * A content tree that would infer its own mode from [contentBackground], inside a window whose
   * show resolved [shownDark]: the window scrim and a pair in the content, as drawn.
   */
  private fun scrimAndContent(shownDark: Boolean, contentBackground: String): Pair<Int, Int> {
    fun tree(background: String) =
      mapPrototypeSpec(
        spec(
          """{"id":"p","window":{"placement":{"type":"fullscreen","scrim":$PAIR}},
            "root":{"type":"box","style":{"width":"fill","height":{"dp":200},"background":"$background"},
              "children":[{"type":"box","style":{$FILL,"background":$PAIR},"children":[]}]}}""",
        ),
      )
    // The tree as it was first shown paints the opposite background of the live content.
    val shown = tree(if (shownDark) "#101010" else "#FFFFFF")
    val live = tree(contentBackground)
    val request =
      shown
        .request()
        .copy(
          theme = prototypeShownThemeFlow(shown),
          content = { PrototypeSpecContent(live.root, live.theme) },
        )
    val image =
      renderComposable("one-mode") { PrototypeWindowContent(request) { PrototypeInsetFloor.None } }
    return image.at(0.5, 0.9) to image.at(0.5, 0.2)
  }

  @Test
  @Config(qualifiers = "+notnight")
  fun theShownModeDrivesTheWindowScrimAndTheContentTogether() {
    // Before #11221 the content inferred its own mode from its live tree while the scrim kept the
    // mode of the tree first shown, so one window drew a blue scrim around red content.
    assertEquals(BLUE to BLUE, scrimAndContent(shownDark = true, contentBackground = "#FFFFFF"))
    assertEquals(RED to RED, scrimAndContent(shownDark = false, contentBackground = "#101010"))
  }

  @Test
  fun fullscreenScrimDrawsPairsAndOtherRolesUnchanged() {
    assertEquals(RED, windowScrim("light", PAIR))
    assertEquals(BLUE, windowScrim("dark", PAIR))
    assertEquals(GREEN, windowScrim("light", "\"primary\""))
    assertEquals(MAGENTA, windowScrim("dark", "\"primary\""))
    assertEquals(HALF_RED, windowScrim("light", "\"#80FF0000\""))
  }

  @Test
  fun fullscreenScrimRoleDrawsAtTheDefaultScrimOpacity() {
    assertEquals(DIM_GREEN, windowScrim("light", "\"scrim\""))
    assertEquals(DIM_MAGENTA, windowScrim("dark", "\"scrim\""))
    assertEquals(RED, windowScrim("light", """{"light":"#FF0000","dark":"scrim"}"""))
    assertEquals(DIM_MAGENTA, windowScrim("dark", """{"light":"#FF0000","dark":"scrim"}"""))
  }

  // Role names in component colour slots (#11219): ignored before, resolved against the theme now.

  private fun component(node: String) =
    mapPrototypeSpec(
      spec(
        """{"id":"p",$FULLSCREEN,"state":{"on":false,"pick":"a"},${roleTheme("dark")},
          "root":{"type":"box","style":{$FILL},"children":[$node]}}""",
      ),
    )

  /** The colour a component's `style.color` resolves to inside the spec's theme. */
  private fun foreground(node: String): Color? {
    val model = component(node)
    var color: Color? = null
    renderComposable("foreground") {
      PrototypeTheme(model.root, model.theme) {
        color = prototypeAuthoredForeground(model.root.children.single())
        // The capture needs a laid-out view; the colour is all this reads.
        Box(Modifier.size(1.dp))
      }
    }
    return color
  }

  @Test
  fun buttonColorRoleResolves() {
    assertEquals(
      Color.Magenta,
      foreground("""{"type":"button","label":"Go","style":{"color":"primary"}}"""),
    )
    assertNull(foreground("""{"type":"button","label":"Go"}"""))
  }

  @Test
  fun checkboxColorRoleResolves() {
    assertEquals(
      Color.Magenta,
      foreground(
        """{"type":"checkbox","stateKey":"on","label":"On","style":{"color":"primary"}}""",
      ),
    )
  }

  @Test
  fun radioGroupColorRoleResolves() {
    assertEquals(
      Color.Magenta,
      foreground(
        """{"type":"radioGroup","stateKey":"pick","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}],
          "style":{"color":"primary"}}""",
      ),
    )
  }

  @Test
  fun listItemColorRoleResolves() {
    assertEquals(
      Color.Magenta,
      foreground("""{"type":"listItem","headline":"Row","style":{"color":"primary"}}"""),
    )
  }

  @Test
  fun cardBackgroundRoleFillsTheCardContainer() {
    val card = """{"type":"card","style":{$FILL,"background":"primary"},"children":[]}"""
    assertEquals(MAGENTA, renderComponent(card).at(0.5, 0.5))
  }

  @Test
  fun listItemBackgroundRoleShowsThroughItsContainer() {
    val item = """{"type":"listItem","headline":"Row","style":{$FILL,"background":"primary"}}"""
    assertEquals(MAGENTA, renderComponent(item).at(0.9, 0.9))
  }

  private fun renderComponent(node: String): PrototypeScreenshotComparator.Image {
    val model = component(node)
    return renderComposable("component") { PrototypeSpecContent(model.root, theme = model.theme) }
  }

  /** Records the asset ids the renderer asks for; every asset is unknown, so nothing decodes. */
  private class RecordingSource : PrototypeAssetSource {
    val lookups = LinkedHashSet<String>()

    override fun lookup(id: String): PrototypeAssetInfo? {
      lookups += id
      return null
    }

    override fun read(id: String): ByteArray? = null

    override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit
  }

  private fun requestedAssets(mode: String): Set<String> {
    val source = RecordingSource()
    val cache = PrototypeImageCache(source, PrototypeImageDecoder { _, _ -> null })
    val model =
      mapPrototypeSpec(
        spec(
          """{"id":"p",$FULLSCREEN,"theme":{"mode":"$mode"},"state":{"tab":0},
            "root":{"type":"column","children":[
              {"type":"image","asset":{"light":"logo-light","dark":"logo-dark"}},
              {"type":"image","asset":"plain"},
              {"type":"bottomNav","stateKey":"tab","items":[
                {"label":"Home","image":{"light":"home-light","dark":"home-dark"}},
                {"label":"Search","icon":"search"}]}]}}""",
        ),
      )
    renderComposable("assets-$mode") {
      CompositionLocalProvider(LocalPrototypeImageCache provides cache) {
        PrototypeSpecContent(model.root, theme = model.theme)
      }
    }
    return source.lookups
  }

  @Test
  fun imageAndNavItemPairsRequestOnlyTheAssetForTheMode() {
    assertEquals(setOf("logo-light", "plain", "home-light"), requestedAssets("light"))
    assertEquals(setOf("logo-dark", "plain", "home-dark"), requestedAssets("dark"))
  }
}
