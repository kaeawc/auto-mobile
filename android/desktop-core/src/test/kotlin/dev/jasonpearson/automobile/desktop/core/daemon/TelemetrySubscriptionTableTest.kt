package dev.jasonpearson.automobile.desktop.core.daemon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TelemetrySubscriptionTableTest {
  private val key = DeviceStreamKey("emulator-5554", "uuid-a")

  private fun entry() = MuxSubscription(key, {}, {}, {})

  @Test
  fun `a release before the ack keeps the request mapped while the socket is live`() {
    val table = TelemetrySubscriptionTable()
    val released = entry().also(table::add)
    assertTrue(table.begin(released, "req-1", null))

    table.remove(released)

    // Its ack can still arrive on the live socket and must be unsubscribed then.
    assertEquals(released, table.acknowledge("req-1", "telemetry-1"))
  }

  @Test
  fun `detaching the socket drops the in-flight requests of released subscriptions`() {
    val table = TelemetrySubscriptionTable()
    val released = entry().also(table::add)
    table.begin(released, "req-1", null)
    table.remove(released)

    table.detach()

    assertNull(table.acknowledge("req-1", "telemetry-1"))
    assertNull(released.requestId)
  }
}
