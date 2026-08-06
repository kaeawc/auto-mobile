package dev.jasonpearson.automobile.desktop.core.navigation

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

class NavigationScreenshotLoaderRegistryTest {

  private val clientProvider: () -> AutoMobileClient = { FakeAutoMobileClient() }

  @Test
  fun `returns the same loader instance for a device so its cache survives`() {
    val registry = NavigationScreenshotLoaderRegistry()
    val first = registry.forDevice("dev-1", clientProvider)
    val second = registry.forDevice("dev-1", clientProvider)
    assertSame("a device must keep one loader (and thus one LRU cache)", first, second)
  }

  @Test
  fun `keeps distinct loaders per device so panes stay isolated`() {
    val registry = NavigationScreenshotLoaderRegistry()
    val a = registry.forDevice("dev-1", clientProvider)
    val b = registry.forDevice("dev-2", clientProvider)
    assertNotSame("distinct devices must not share a loader", a, b)
  }
}
