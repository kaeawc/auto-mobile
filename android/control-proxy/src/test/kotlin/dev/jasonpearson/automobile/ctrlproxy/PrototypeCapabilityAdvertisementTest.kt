package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.prototype.AutoMobilePrototype
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import org.junit.After
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
}
