package dev.jasonpearson.automobile.wearfixture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FixtureBackStackTest {
  @Test
  fun `starts at home and cannot pop past it`() {
    val stack = FixtureBackStack()
    assertEquals(FixtureRoute.Home, stack.current)
    assertFalse(stack.canPop)
    assertEquals(stack, stack.pop())
  }

  @Test
  fun `push then pop returns to the previous screen`() {
    val detail = FixtureBackStack().push(FixtureRoute.Detail("item_03"))
    assertEquals(FixtureRoute.Detail("item_03"), detail.current)
    assertTrue(detail.canPop)
    assertEquals(FixtureRoute.Home, detail.pop().current)
  }

  @Test
  fun `pushing the current screen again is a no-op`() {
    val picker = FixtureBackStack().push(FixtureRoute.Picker)
    assertEquals(picker, picker.push(FixtureRoute.Picker))
  }

  @Test
  fun `routes round-trip through their saved strings`() {
    val stack =
      FixtureBackStack()
        .push(FixtureRoute.Picker)
        .push(FixtureRoute.Dismiss)
        .push(FixtureRoute.Detail("item_30"))
    assertEquals(listOf("home", "picker", "dismiss", "detail/item_30"), stack.toRoutes())
    assertEquals(stack, FixtureBackStack.fromRoutes(stack.toRoutes()))
  }

  @Test
  fun `stale or unknown saved routes fall back to a home-rooted stack`() {
    assertNull(FixtureRoute.parse("detail/item_99"))
    assertNull(FixtureRoute.parse("settings"))
    assertEquals(FixtureBackStack(), FixtureBackStack.fromRoutes(emptyList()))
    assertEquals(FixtureBackStack(), FixtureBackStack.fromRoutes(listOf("picker")))
    assertEquals(
      listOf("home", "detail/item_01"),
      FixtureBackStack.fromRoutes(listOf("home", "settings", "detail/item_01")).toRoutes(),
    )
  }
}
