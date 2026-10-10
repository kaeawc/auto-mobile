package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import android.app.Application
import androidx.compose.runtime.CompositionLocalProvider
import dev.jasonpearson.automobile.ctrlproxy.prototype.LocalPrototypeImageCache
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetChangeListener
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetInfo
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetSource
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImageCache
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImageDecoder
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeInsetFloor
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeSpecContent
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeWindowContent
import dev.jasonpearson.automobile.ctrlproxy.prototype.mapPrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import org.junit.Assert.assertEquals
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

  private fun sheet(mode: String, scrim: String) =
    spec(
      """{"id":"p",$FULLSCREEN,"state":{"open":true},
        "theme":{"mode":"$mode","colors":{"light":{"scrim":"#00FF00"},"dark":{"scrim":"#FF00FF"}}},
        "root":{"type":"box","style":{$FILL},"children":[
          {"type":"bottomSheet","openWhen":{"key":"open","equals":true},"detents":["half"],
            "scrim":$scrim,"child":{"type":"spacer"}}]}}""",
    )

  @Test
  fun bottomSheetScrimDrawsPairsAndRolesForTheMode() {
    assertEquals(RED, renderPrototype("sheet-light", sheet("light", PAIR)).at(0.5, 0.1))
    assertEquals(BLUE, renderPrototype("sheet-dark", sheet("dark", PAIR)).at(0.5, 0.1))
    assertEquals(GREEN, renderPrototype("sheet-role-l", sheet("light", "\"scrim\"")).at(0.5, 0.1))
    assertEquals(MAGENTA, renderPrototype("sheet-role-d", sheet("dark", "\"scrim\"")).at(0.5, 0.1))
  }

  /** The window scrim is host chrome, drawn by `PrototypeWindowContent` behind the spec. */
  private fun windowScrim(mode: String, scrim: String): Int {
    val model =
      mapPrototypeSpec(
        spec(
          """{"id":"p","window":{"placement":{"type":"fullscreen","scrim":$scrim}},
            "theme":{"mode":"$mode","colors":{"dark":{"scrim":"#FF00FF"}}},
            "root":{"type":"spacer"}}""",
        ),
      )
    // The controller hands the host the spec's root and theme the same way.
    val request = model.request().copy(themeRoot = model.root, specTheme = model.theme)
    return renderComposable("scrim-$mode") {
        PrototypeWindowContent(request) { PrototypeInsetFloor.None }
      }
      .at(0.5, 0.9)
  }

  @Test
  fun fullscreenScrimDrawsPairsAndRolesForTheMode() {
    assertEquals(RED, windowScrim("light", PAIR))
    assertEquals(BLUE, windowScrim("dark", PAIR))
    assertEquals(MAGENTA, windowScrim("dark", "\"scrim\""))
    assertEquals(RED, windowScrim("light", """{"light":"#FF0000","dark":"scrim"}"""))
    assertEquals(MAGENTA, windowScrim("dark", """{"light":"#FF0000","dark":"scrim"}"""))
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
