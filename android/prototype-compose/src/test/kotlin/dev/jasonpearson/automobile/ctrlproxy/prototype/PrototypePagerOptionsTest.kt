package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.pager.PageSize
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypePagerPageSize
import dev.jasonpearson.automobile.protocol.PrototypePagerPeek
import org.junit.Assert.*
import org.junit.Test

class PrototypePagerOptionsTest {
  @Test
  fun `omitted options preserve zero padding fill and zero spacing`() {
    for (axis in listOf(null, "horizontal", "vertical")) {
      val padding = pagerContentPadding(axis, null)
      assertEquals(0.dp, padding.calculateLeftPadding(LayoutDirection.Ltr))
      assertEquals(0.dp, padding.calculateRightPadding(LayoutDirection.Ltr))
      assertEquals(0.dp, padding.calculateTopPadding())
      assertEquals(0.dp, padding.calculateBottomPadding())
    }
    assertSame(PageSize.Fill, pagerPageSize(null))
    assertSame(PageSize.Fill, pagerPageSize(PrototypePagerPageSize.Fill))
    assertEquals(0.dp, pagerPageSpacing(null))
  }

  @Test
  fun `horizontal peek uses logical start and end padding`() {
    val padding = pagerContentPadding("horizontal", PrototypePagerPeek(12.0, 24.0))
    assertEquals(12.dp, padding.calculateLeftPadding(LayoutDirection.Ltr))
    assertEquals(24.dp, padding.calculateRightPadding(LayoutDirection.Ltr))
    assertEquals(24.dp, padding.calculateLeftPadding(LayoutDirection.Rtl))
    assertEquals(12.dp, padding.calculateRightPadding(LayoutDirection.Rtl))
    assertEquals(0.dp, padding.calculateTopPadding())
    assertEquals(0.dp, padding.calculateBottomPadding())
  }

  @Test
  fun `vertical peek uses top and bottom padding`() {
    val padding = pagerContentPadding("vertical", PrototypePagerPeek(12.0, 24.0))
    assertEquals(0.dp, padding.calculateLeftPadding(LayoutDirection.Ltr))
    assertEquals(0.dp, padding.calculateRightPadding(LayoutDirection.Ltr))
    assertEquals(12.dp, padding.calculateTopPadding())
    assertEquals(24.dp, padding.calculateBottomPadding())
    assertEquals(
      0.dp,
      pagerContentPadding(null, PrototypePagerPeek(end = 5.0))
        .calculateLeftPadding(LayoutDirection.Ltr),
    )
    assertEquals(
      0.dp,
      pagerContentPadding("vertical", PrototypePagerPeek(start = 5.0)).calculateBottomPadding(),
    )
  }

  @Test
  fun `fixed page extent and spacing map from authored dp`() {
    val size = pagerPageSize(PrototypePagerPageSize.Dp(120.5))
    assertTrue(size is PageSize.Fixed)
    with(size) {
      with(Density(2f)) { assertEquals(241, calculateMainAxisPageSize(1000, 8)) }
    }
    assertEquals(8.5.dp, pagerPageSpacing(8.5))
  }
}
