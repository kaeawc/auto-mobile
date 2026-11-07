package dev.jasonpearson.automobile.tvfixture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FixtureBackStackTest {
  @Test
  fun `routes parse back to the same screens`() {
    listOf(
        FixtureRoute.Browse,
        FixtureRoute.Search,
        FixtureRoute.Player,
        FixtureRoute.Detail("card_movies_07"),
      )
      .forEach { assertEquals(it, FixtureRoute.parse(it.route)) }
    assertNull(FixtureRoute.parse("detail/card_movies_99"))
    assertNull(FixtureRoute.parse("settings"))
  }

  @Test
  fun `pushing the current route is a no-op and browse never pops`() {
    val stack = FixtureBackStack().push(FixtureRoute.Search).push(FixtureRoute.Search)
    assertEquals(listOf("browse", "search"), stack.toRoutes())
    assertEquals(FixtureBackStack(), FixtureBackStack().pop())
  }

  @Test
  fun `a saved stack drops entries before browse and unknown routes`() {
    val restored =
      FixtureBackStack.fromRoutes(listOf("search", "browse", "nope", "detail/card_shows_01"))
    assertEquals(listOf("browse", "detail/card_shows_01"), restored.toRoutes())
    assertEquals(FixtureBackStack(), FixtureBackStack.fromRoutes(emptyList()))
  }
}
