package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.ui.layout.ContentScale
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Test

class OverlayImageSelectionTest {
  private class StubImage : OverlayDecodedImage {
    override val width = 1
    override val height = 1
    override val byteCount = 4L
  }

  private val ready = OverlayImageState.Ready(StubImage())

  @Test
  fun `a nav image takes precedence over its icon once it is ready`() {
    val item = OverlayItem("Home", icon = "home", image = "logo")
    assertEquals(OverlayNavigationVisual.Image(ready.image), overlayNavigationVisual(item, ready))
  }

  @Test
  fun `a nav item shows a neutral box while its image decodes`() {
    val item = OverlayItem("Home", icon = "home", image = "logo")
    assertEquals(
      OverlayNavigationVisual.Loading,
      overlayNavigationVisual(item, OverlayImageState.Loading),
    )
  }

  @Test
  fun `a missing nav image falls back to the icon then to the placeholder`() {
    assertEquals(
      OverlayNavigationVisual.Icon("home"),
      overlayNavigationVisual(
        OverlayItem("Home", icon = "home", image = "logo"),
        OverlayImageState.Missing,
      ),
    )
    assertEquals(
      OverlayNavigationVisual.Placeholder,
      overlayNavigationVisual(OverlayItem("Home", image = "logo"), OverlayImageState.Missing),
    )
  }

  @Test
  fun `an item without an image uses its icon or the placeholder`() {
    assertEquals(
      OverlayNavigationVisual.Icon("search"),
      overlayNavigationVisual(OverlayItem("Find", icon = "search"), null),
    )
    assertEquals(
      OverlayNavigationVisual.Placeholder,
      overlayNavigationVisual(OverlayItem("Find"), null),
    )
    assertEquals(
      OverlayNavigationVisual.Placeholder,
      overlayNavigationVisual(OverlayItem("Find", icon = "not_a_builtin"), null),
    )
  }

  @Test
  fun `content scale names map to Compose scales and the protocol default is fit`() {
    assertEquals(ContentScale.Fit, overlayContentScale("fit"))
    assertEquals(ContentScale.Crop, overlayContentScale("crop"))
    assertEquals(ContentScale.FillBounds, overlayContentScale("fill"))
    assertEquals(ContentScale.Fit, overlayContentScale(OverlayImageNode(asset = "a").contentScale))
  }

  @Test
  fun `references cover image nodes and nav images across the whole tree without repeats`() {
    val root =
      OverlayColumnNode(
        children =
          listOf(
            OverlayImageNode(asset = "hero"),
            OverlayRowNode(
              children = listOf(OverlayImageNode(asset = "hero", contentScale = "crop")),
            ),
            OverlayPagerNode(
              id = "pages",
              children =
                listOf(
                  OverlayTextNode(text = "one"),
                  OverlayScrollNode(child = OverlayImageNode(asset = "second-page")),
                ),
            ),
            OverlayBottomSheetNode(
              child = OverlayImageNode(asset = "sheet"),
              openWhen = OverlaySheetCondition("open", true),
              detents = listOf(OverlayDetent.Half),
            ),
            OverlayTabBarNode(
              items = listOf(OverlayItem("A", image = "tab-a"), OverlayItem("B", icon = "home")),
              pager = "pages",
            ),
            OverlayBottomNavNode(
              items = listOf(OverlayItem("C", image = "hero"), OverlayItem("D", image = "nav-d")),
              stateKey = "tab",
            ),
          ),
      )
    assertEquals(
      listOf("hero", "second-page", "sheet", "tab-a", "nav-d"),
      overlayAssetReferences(root),
    )
  }

  @Test
  fun `a tree with no images references nothing`() {
    assertEquals(emptyList<String>(), overlayAssetReferences(OverlayTextNode(text = "hi")))
  }
}
