package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeRuntimePlatform
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import dev.jasonpearson.automobile.prototype.PlatformAvailability
import dev.jasonpearson.automobile.prototype.PrototypePlatform
import dev.jasonpearson.automobile.prototype.TestPlatformModule
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Advertisement checks need neither an Android runner nor a started server. */
class PrototypeCapabilityAdvertisementTest {
  private val scope = TestScope()

  @After
  fun tearDown() {
    scope.cancel()
  }

  @Test
  fun `renderer capabilities are advertised by CtrlProxy`() {
    val commands =
      WebSocketServer(port = 0, scope = scope, options = WebSocketServerOptions(sdkInt = { 36 }))
        .supportedCommands()
    val missing = AutoMobilePrototype.capabilities - commands.toSet()
    assertTrue("CtrlProxy is missing renderer capabilities: $missing", missing.isEmpty())
  }

  @Test
  fun `advertisement adds exactly the registered capabilities and overlay needs no permission`() {
    fun commands(platform: PrototypePlatform) =
      WebSocketServer(
          port = 0,
          scope = scope,
          options = WebSocketServerOptions(sdkInt = { 36 }),
          platform = platform,
        )
        .supportedCommands()
        .toSet()
    val platform = PrototypePlatform(listOf(TestPlatformModule()))
    assertEquals(
      platform.registry.capabilities,
      commands(platform) - commands(PrototypePlatform.None),
    )
    assertEquals(
      AutoMobilePrototype.capabilities + platform.registry.capabilities,
      AutoMobilePrototype.capabilities(platform),
    )
    assertFalse(commands(PrototypePlatform.None).contains("prototype_platform_test_v1"))
    // The gateways reach for the context lazily, so a bare wrapper is enough to register them.
    val overlay = prototypeRuntimePlatform(android.content.ContextWrapper(null))
    assertEquals(
      setOf(
        "prototype_platform_connectivity_v1",
        "prototype_platform_haptics_v1",
        "prototype_platform_sound_v1",
        "prototype_platform_test_v1",
      ),
      overlay.registry.capabilities,
    )
    assertTrue(
      overlay.registry.modules.all {
        it.availability() == PlatformAvailability.Ready
      },
    )
  }
}
