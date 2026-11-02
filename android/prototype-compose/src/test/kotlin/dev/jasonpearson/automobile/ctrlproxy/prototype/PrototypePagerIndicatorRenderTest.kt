package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypePagerIndicatorRenderTest {
  @get:Rule val compose = createComposeRule()

  private fun show(root: PrototypeNode) {
    val spec =
      PrototypeSpec("pager-test", PrototypeWindow(PrototypeFullscreenPlacement()), root = root)
    val model = mapPrototypeSpec(spec).root
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeMotion provides false) {
        Box(Modifier.size(320.dp, 400.dp)) { PrototypeSpecContent(model) {} }
      }
    }
  }

  private fun showDefaultHeightPager(placement: String) {
    show(
      PrototypeScrollNode(
        child =
          PrototypeColumnNode(
            children =
              listOf(
                PrototypeTextNode(text = "Above the pager"),
                PrototypePagerNode(
                  id = "pager",
                  testTag = "pager",
                  indicator = "dots",
                  indicatorPlacement = placement,
                  children =
                    List(2) {
                      PrototypeCardNode(
                        testTag = "card-$it",
                        style = PrototypeStyle(minHeight = 100.0),
                        children = listOf(PrototypeTextNode(text = "Page $it")),
                      )
                    },
                ),
                PrototypeTextNode(text = "Below the pager", testTag = "after"),
              ),
          ),
      ),
    )
  }

  @Test
  fun `default height over pager in a vertical scroll keeps its 100dp outer minimum`() {
    showDefaultHeightPager("over")
    val card = compose.onNodeWithTag("card-0").assertIsDisplayed().getBoundsInRoot()
    val pager = compose.onNodeWithTag("pager").getBoundsInRoot()
    // The tagged Material surface wraps its text inside the card's outer sizeIn minimum.
    assertTrue(card.right - card.left > 0.dp)
    assertTrue(card.bottom - card.top > 0.dp)
    assertTrue(pager.bottom - pager.top >= 100.dp)
  }

  @Test
  fun `default height below pager in a vertical scroll reserves its strip after 100dp pages`() {
    showDefaultHeightPager("below")
    val pager = compose.onNodeWithTag("pager").getBoundsInRoot()
    val after = compose.onNodeWithTag("after").getBoundsInRoot()
    assertTrue(pager.bottom - pager.top >= 122.dp)
    assertTrue(after.top >= pager.bottom)
  }

  private fun showDefaultWidthVerticalPager(placement: String) {
    show(
      PrototypeScrollNode(
        axis = "horizontal",
        child =
          PrototypeRowNode(
            children =
              listOf(
                PrototypeTextNode(text = "Before"),
                PrototypePagerNode(
                  id = "pager",
                  testTag = "pager",
                  axis = "vertical",
                  style = PrototypeStyle(height = PrototypeDimension.Dp(200.0)),
                  indicator = "dots",
                  indicatorPlacement = placement,
                  children =
                    List(2) {
                      PrototypeCardNode(
                        testTag = "card-$it",
                        style = PrototypeStyle(minWidth = 100.0),
                        children = listOf(PrototypeTextNode(text = "Page $it")),
                      )
                    },
                ),
                PrototypeTextNode(text = "After", testTag = "after"),
              ),
          ),
      ),
    )
  }

  @Test
  fun `default width vertical over pager in a horizontal scroll keeps its 100dp outer minimum`() {
    showDefaultWidthVerticalPager("over")
    val card = compose.onNodeWithTag("card-0").assertIsDisplayed().getBoundsInRoot()
    val pager = compose.onNodeWithTag("pager").getBoundsInRoot()
    // The tagged Material surface wraps its text inside the card's outer sizeIn minimum.
    assertTrue(card.right - card.left > 0.dp)
    assertTrue(card.bottom - card.top > 0.dp)
    assertTrue(pager.right - pager.left >= 100.dp)
  }

  @Test
  fun `default width vertical below pager in a horizontal scroll reserves its strip after 100dp pages`() {
    showDefaultWidthVerticalPager("below")
    val pager = compose.onNodeWithTag("pager").getBoundsInRoot()
    val after = compose.onNodeWithTag("after").getBoundsInRoot()
    assertTrue(pager.right - pager.left >= 122.dp)
    assertTrue(after.left >= pager.right)
  }

  private fun showBoundedWrapPager(availableHeight: Dp, pageHeight: Dp) {
    compose.setContent {
      val state = rememberPagerState { 2 }
      PrototypePagerIndicatorLayout(
        state,
        false,
        PrototypePagerIndicator("dots", "below", PrototypePageFill(width = true, height = false)),
        Modifier.width(200.dp).heightIn(max = availableHeight).testTag("pager"),
      ) { modifier ->
        HorizontalPager(state, modifier.testTag("pages")) { index ->
          Box(Modifier.width(200.dp).height(pageHeight).testTag("card-$index"))
        }
      }
    }
  }

  @Test
  fun `23dp bound uses overlay instead of a partial strip overlapping wrap pages`() {
    showBoundedWrapPager(23.dp, 20.dp)
    // Overlay has no reserved strip: the pager and its pages have exactly the same bounds.
    compose.onNodeWithTag("pager").assertHeightIsEqualTo(20.dp)
    compose.onNodeWithTag("card-0").assertHeightIsEqualTo(20.dp)
    assertEquals(
      compose.onNodeWithTag("pages").getBoundsInRoot(),
      compose.onNodeWithTag("pager").getBoundsInRoot(),
    )
  }

  @Test
  fun `measured wrap pages leave too little room for a complete strip and use overlay`() {
    showBoundedWrapPager(100.dp, 90.dp)
    compose.onNodeWithTag("pager").assertHeightIsEqualTo(90.dp)
    compose.onNodeWithTag("card-0").assertHeightIsEqualTo(90.dp)
    assertEquals(
      compose.onNodeWithTag("pages").getBoundsInRoot(),
      compose.onNodeWithTag("pager").getBoundsInRoot(),
    )
  }

  @Test
  fun `wrap pages with enough room have a complete strip after their bottom edge`() {
    showBoundedWrapPager(100.dp, 50.dp)
    compose.onNodeWithTag("pager").assertHeightIsEqualTo(72.dp)
    val page = compose.onNodeWithTag("pages").getBoundsInRoot()
    val pager = compose.onNodeWithTag("pager").getBoundsInRoot()
    assertEquals(page.bottom + 22.dp, pager.bottom)
  }

  @Test
  fun `fixed 200dp wrap pager leaves room for its row sibling`() {
    show(
      PrototypeRowNode(
        children =
          listOf(
            PrototypePagerNode(
              id = "pager",
              testTag = "pager",
              style =
                PrototypeStyle(width = PrototypeDimension.Wrap, height = PrototypeDimension.Wrap),
              pageSize = PrototypePagerPageSize.Dp(200.0),
              indicator = "dots",
              indicatorPlacement = "below",
              children =
                listOf(
                  PrototypeBoxNode(
                    testTag = "card",
                    style =
                      PrototypeStyle(
                        width = PrototypeDimension.Dp(200.0),
                        height = PrototypeDimension.Dp(100.0),
                      ),
                    children = emptyList(),
                  ),
                ),
            ),
            PrototypeBoxNode(
              testTag = "sibling",
              style =
                PrototypeStyle(
                  width = PrototypeDimension.Dp(80.0),
                  height = PrototypeDimension.Dp(100.0),
                ),
              children = emptyList(),
            ),
          ),
      ),
    )
    compose.onNodeWithTag("pager").assertWidthIsEqualTo(200.dp)
    compose.onNodeWithTag("sibling").assertWidthIsEqualTo(80.dp)
    val pager = compose.onNodeWithTag("pager").getBoundsInRoot()
    val sibling = compose.onNodeWithTag("sibling").getBoundsInRoot()
    assertTrue(sibling.left >= pager.right)
  }

  @Test
  fun `fill pages still use the bounded height remaining after the strip`() {
    show(
      PrototypePagerNode(
        id = "pager",
        testTag = "pager",
        style =
          PrototypeStyle(width = PrototypeDimension.Fill, height = PrototypeDimension.Dp(200.0)),
        pageSize = PrototypePagerPageSize.Fill,
        indicator = "dots",
        indicatorPlacement = "below",
        children =
          listOf(
            PrototypeBoxNode(
              testTag = "card",
              style =
                PrototypeStyle(width = PrototypeDimension.Fill, height = PrototypeDimension.Fill),
              children = emptyList(),
            ),
          ),
      ),
    )
    compose.onNodeWithTag("pager").assertWidthIsEqualTo(320.dp).assertHeightIsEqualTo(200.dp)
    compose.onNodeWithTag("card").assertWidthIsEqualTo(320.dp).assertHeightIsEqualTo(178.dp)
  }
}
