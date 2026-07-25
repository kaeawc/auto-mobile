package dev.jasonpearson.automobile.sdk.adapters

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for [circuitDestinationName], the Circuit destination-name derivation helper. */
class CircuitDestinationNameTest {

  private object HomeScreen

  private class ProfileScreen

  @Test
  fun `named object resolves to its simple name`() {
    assertEquals("HomeScreen", circuitDestinationName(HomeScreen))
  }

  @Test
  fun `named class instance resolves to its simple name`() {
    assertEquals("ProfileScreen", circuitDestinationName(ProfileScreen()))
  }

  @Test
  fun `anonymous destinations resolve to a stable name across instances`() {
    // Each call instantiates the same anonymous class, so the derived name must be identical —
    // the identity-based Any#toString() would otherwise differ per instance.
    fun newAnonymousDestination(): Any = object {}

    val first = circuitDestinationName(newAnonymousDestination())
    val second = circuitDestinationName(newAnonymousDestination())

    assertTrue(first.isNotEmpty())
    assertEquals(first, second)
  }
}
