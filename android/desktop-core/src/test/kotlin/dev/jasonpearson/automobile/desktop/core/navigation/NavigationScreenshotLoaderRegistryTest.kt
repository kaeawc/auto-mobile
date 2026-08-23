package dev.jasonpearson.automobile.desktop.core.navigation

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
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

  @Test
  fun `forget releases a device's loader so its cache is not retained`() {
    val registry = NavigationScreenshotLoaderRegistry()
    registry.forDevice("dev-1", clientProvider)
    assertNotNull("loader should exist before forget", registry.peek("dev-1"))

    registry.forget("dev-1")

    assertNull("forget must release the device's loader", registry.peek("dev-1"))
  }

  @Test
  fun `forget only affects the named device`() {
    val registry = NavigationScreenshotLoaderRegistry()
    val kept = registry.forDevice("dev-1", clientProvider)
    registry.forDevice("dev-2", clientProvider)

    registry.forget("dev-2")

    assertSame("an untouched device keeps its loader", kept, registry.peek("dev-1"))
    assertNull("the forgotten device is released", registry.peek("dev-2"))
  }

  @Test
  fun `forget for an unknown device is a no-op`() {
    val registry = NavigationScreenshotLoaderRegistry()
    // Must not throw when no loader was ever created for the device.
    registry.forget("never-seen")
    assertNull(registry.peek("never-seen"))
  }

  @Test
  fun `forDevice after forget creates a fresh loader`() {
    val registry = NavigationScreenshotLoaderRegistry()
    val first = registry.forDevice("dev-1", clientProvider)
    registry.forget("dev-1")
    val second = registry.forDevice("dev-1", clientProvider)
    assertNotSame("a re-added device must get a new loader (empty cache)", first, second)
  }
}
