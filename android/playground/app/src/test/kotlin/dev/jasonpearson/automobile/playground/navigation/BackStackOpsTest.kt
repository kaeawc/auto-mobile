package dev.jasonpearson.automobile.playground.navigation

import androidx.navigation3.runtime.NavKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BackStackOpsTest {

  @Test
  fun `back from a lone unknown video goes home`() {
    val backStack = mutableListOf<AppDestination>(VideoPlayerDestination("unknown"))

    val destination = backStack.popOrGoHome(HomeDestination())

    assertEquals(HomeDestination(), destination)
    assertEquals(listOf(HomeDestination()), backStack)
  }

  @Test
  fun `back pops to the actual previous destination`() {
    val previous = SlidesDestination(3)
    val backStack =
      mutableListOf<AppDestination>(HomeDestination(), previous, VideoPlayerDestination("unknown"))

    assertEquals(previous, backStack.popOrGoHome(HomeDestination()))
    assertEquals(listOf(HomeDestination(), previous), backStack)
    assertEquals(HomeDestination(), backStack.popOrGoHome(HomeDestination()))
    assertEquals(listOf(HomeDestination()), backStack)
  }

  @Test
  fun `back preserves lone root destinations`() {
    val roots =
      listOf(
        HomeDestination(),
        HomeDestination(selectedTab = 2),
        OnboardingDestination,
        LoginDestination,
      )
    for (root in roots) {
      val backStack = mutableListOf<AppDestination>(root)

      assertEquals(root, backStack.popOrGoHome(HomeDestination()))
      assertEquals(listOf(root), backStack)
    }
  }

  @Test
  fun `back repairs an empty stack`() {
    val backStack = mutableListOf<AppDestination>()

    assertEquals(HomeDestination(), backStack.popOrGoHome(HomeDestination()))
    assertEquals(listOf(HomeDestination()), backStack)
  }

  @Test
  fun `restart double pop stops at home without emptying the stack`() {
    val stacks =
      listOf(
        mutableListOf<AppDestination>(
          HomeDestination(),
          DemoUxStartDestination,
          DemoUxSummaryDestination,
        ),
        mutableListOf<AppDestination>(HomeDestination(), DemoUxSummaryDestination),
        mutableListOf<AppDestination>(VideoPlayerDestination("unknown")),
        mutableListOf<AppDestination>(HomeDestination()),
      )
    for (backStack in stacks) {
      repeat(2) {
        backStack.popOrGoHome(HomeDestination())
        // Check the invariant after each pop, not just the final state.
        assertTrue(backStack.isNotEmpty())
      }

      assertEquals(listOf(HomeDestination()), backStack)
    }
  }

  @Test
  fun `back supports the NavKey list used by NavBackStack`() {
    val backStack = mutableListOf<NavKey>(VideoPlayerDestination("unknown"))

    assertEquals(HomeDestination(), backStack.popOrGoHome(HomeDestination()))
    assertEquals(listOf(HomeDestination()), backStack)
  }
}
