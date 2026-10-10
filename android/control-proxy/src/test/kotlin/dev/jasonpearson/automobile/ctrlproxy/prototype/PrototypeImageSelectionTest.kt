package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.layout.ContentScale
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Test

class PrototypeImageSelectionTest {
  private class StubImage : PrototypeDecodedImage {
    override val width = 1
    override val height = 1
    override val byteCount = 4L
  }

  private val ready = PrototypeImageState.Ready(StubImage())

  @Test
  fun `a nav image takes precedence over its icon once it is ready`() {
    val item = PrototypeItem("Home", icon = "home", image = "logo")
    assertEquals(
      PrototypeNavigationVisual.Image(ready.image),
      prototypeNavigationVisual(item, ready),
    )
  }

  @Test
  fun `a nav item shows a neutral box while its image decodes`() {
    val item = PrototypeItem("Home", icon = "home", image = "logo")
    assertEquals(
      PrototypeNavigationVisual.Loading,
      prototypeNavigationVisual(item, PrototypeImageState.Loading),
    )
  }

  @Test
  fun `a missing nav image falls back to the icon then to the placeholder`() {
    assertEquals(
      PrototypeNavigationVisual.Icon("home"),
      prototypeNavigationVisual(
        PrototypeItem("Home", icon = "home", image = "logo"),
        PrototypeImageState.Missing,
      ),
    )
    assertEquals(
      PrototypeNavigationVisual.Placeholder,
      prototypeNavigationVisual(PrototypeItem("Home", image = "logo"), PrototypeImageState.Missing),
    )
  }

  @Test
  fun `an item without an image uses its icon or the placeholder`() {
    assertEquals(
      PrototypeNavigationVisual.Icon("search"),
      prototypeNavigationVisual(PrototypeItem("Find", icon = "search"), null),
    )
    assertEquals(
      PrototypeNavigationVisual.Placeholder,
      prototypeNavigationVisual(PrototypeItem("Find"), null),
    )
    assertEquals(
      PrototypeNavigationVisual.Placeholder,
      prototypeNavigationVisual(PrototypeItem("Find", icon = "not_a_builtin"), null),
    )
  }

  @Test
  fun `content scale names map to Compose scales and the protocol default is fit`() {
    assertEquals(ContentScale.Fit, prototypeContentScale("fit"))
    assertEquals(ContentScale.Crop, prototypeContentScale("crop"))
    assertEquals(ContentScale.FillBounds, prototypeContentScale("fill"))
    assertEquals(
      ContentScale.Fit,
      prototypeContentScale(
        PrototypeImageNode(asset = PrototypeModeValue.Single("a")).contentScale,
      ),
    )
  }

  @Test
  fun `references cover image nodes and nav images across the whole tree without repeats`() {
    val root =
      PrototypeColumnNode(
        children =
          listOf(
            PrototypeImageNode(asset = PrototypeModeValue.Single("hero")),
            PrototypeRowNode(
              children =
                listOf(
                  PrototypeImageNode(
                    asset = PrototypeModeValue.Single("hero"),
                    contentScale = "crop",
                  ),
                ),
            ),
            PrototypePagerNode(
              id = "pages",
              children =
                listOf(
                  PrototypeTextNode(text = "one"),
                  PrototypeScrollNode(
                    child = PrototypeImageNode(asset = PrototypeModeValue.Single("second-page")),
                  ),
                ),
            ),
            PrototypeBottomSheetNode(
              child = PrototypeImageNode(asset = PrototypeModeValue.Single("sheet")),
              openWhen = PrototypeSheetCondition("open", true),
              detents = listOf(PrototypeDetent.Half),
            ),
            PrototypeTabBarNode(
              items =
                listOf(PrototypeItem("A", image = "tab-a"), PrototypeItem("B", icon = "home")),
              pager = "pages",
            ),
            PrototypeBottomNavNode(
              items =
                listOf(PrototypeItem("C", image = "hero"), PrototypeItem("D", image = "nav-d")),
              stateKey = "tab",
            ),
          ),
      )
    assertEquals(
      listOf("hero", "second-page", "sheet", "tab-a", "nav-d"),
      prototypeAssetReferences(root),
    )
  }

  @Test
  fun `a tree with no images references nothing`() {
    assertEquals(emptyList<String>(), prototypeAssetReferences(PrototypeTextNode(text = "hi")))
  }
}
