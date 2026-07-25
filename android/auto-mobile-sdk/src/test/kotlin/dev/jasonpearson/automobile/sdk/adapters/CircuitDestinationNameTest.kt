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
  fun `anonymous destination falls back to toString`() {
    val anonymous = object {}

    val name = circuitDestinationName(anonymous)

    // Anonymous classes have no simple name, so the helper must fall back to a non-empty value.
    assertTrue(name.isNotEmpty())
  }
}
