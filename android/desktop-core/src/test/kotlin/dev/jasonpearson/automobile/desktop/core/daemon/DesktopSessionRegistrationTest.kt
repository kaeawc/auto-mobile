package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DesktopSessionRegistrationTest {
  @Test
  fun `registration is idempotent and failed heartbeat requires re-registration`() {
    val calls = mutableListOf<String>()
    var heartbeatFails = false
    val registration =
      DesktopSessionRegistration(
        register = { calls += "register" },
        heartbeat = {
          calls += "heartbeat"
          check(!heartbeatFails)
        },
      )
    assertFalse(registration.isRegistered.value)
    registration.ensureRegistered()
    registration.ensureRegistered()
    registration.heartbeat()
    assertTrue(registration.isRegistered.value)
    heartbeatFails = true
    assertFailsWith<IllegalStateException> { registration.heartbeat() }
    assertFalse(registration.isRegistered.value)
    registration.ensureRegistered()
    assertEquals(listOf("register", "heartbeat", "heartbeat", "register"), calls)
  }

  @Test
  fun `registration failure stays unready and device binding promotes readiness`() {
    val registration = DesktopSessionRegistration({ error("unavailable") }, {})
    assertFailsWith<IllegalStateException> { registration.ensureRegistered() }
    assertFalse(registration.isRegistered.value)
    registration.deviceBound()
    assertTrue(registration.isRegistered.value)
    registration.clear()
    assertFalse(registration.isRegistered.value)
  }

  @Test
  fun `only an acknowledged bind counts as holding a device until cleared`() {
    val registration = DesktopSessionRegistration({}, {})
    registration.deviceBound(held = false)
    assertTrue(registration.isRegistered.value)
    assertFalse(registration.holdsDevice)
    registration.deviceBound(held = true)
    assertTrue(registration.holdsDevice)
    registration.clear()
    assertFalse(registration.holdsDevice)
  }

  @Test
  fun `failures subscribe frame includes the provider session UUID`() {
    var registered = false
    val client = FailuresPushSocketClient { "desktop-session".takeIf { registered } }
    client.connect()
    assertEquals(null, client.subscribeRequest(null, null).sessionUuid)
    registered = true
    val frame =
      DaemonJson.encodeToString(
        FailuresPushRequest.serializer(),
        client.subscribeRequest(null, null),
      )
    assertTrue(frame.contains("\"sessionUuid\":\"desktop-session\""))
    client.dispose()
  }
}
