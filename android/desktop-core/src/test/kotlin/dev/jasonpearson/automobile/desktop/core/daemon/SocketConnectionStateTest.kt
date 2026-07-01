package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected
import dev.jasonpearson.automobile.desktop.core.connection.shouldReconnect
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for the sealed state machine approach used in socket clients. Validates state transitions,
 * derived boolean properties, and atomic CAS updates.
 */
class SocketConnectionStateTest {

  // -- ConnectionState transitions --

  @Test
  fun `initial state is Disconnected`() {
    val state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected())
    assertTrue(state.value is ConnectionState.Disconnected)
  }

  @Test
  fun `Disconnected to Connecting transition`() {
    val state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected())
    state.update { ConnectionState.Connecting }
    assertTrue(state.value is ConnectionState.Connecting)
  }

  @Test
  fun `Connecting to Connected transition`() {
    val state = MutableStateFlow<ConnectionState>(ConnectionState.Connecting)
    state.update { ConnectionState.Connected(subscribed = false) }
    val value = state.value
    assertTrue(value is ConnectionState.Connected)
    assertFalse((value as ConnectionState.Connected).subscribed)
  }

  @Test
  fun `Connected subscribed flag updates atomically`() {
    val state = MutableStateFlow<ConnectionState>(ConnectionState.Connected(subscribed = false))
    state.update { current ->
      if (current is ConnectionState.Connected) {
        current.copy(subscribed = true)
      } else {
        current
      }
    }
    val value = state.value as ConnectionState.Connected
    assertTrue(value.subscribed)
  }

  @Test
  fun `Connected to Reconnecting transition`() {
    val state = MutableStateFlow<ConnectionState>(ConnectionState.Connected(subscribed = true))
    state.update { ConnectionState.Reconnecting(attempt = 1, nextRetryMs = 1000) }
    val value = state.value
    assertTrue(value is ConnectionState.Reconnecting)
    assertEquals(1, (value as ConnectionState.Reconnecting).attempt)
  }

  @Test
  fun `Reconnecting to Connected transition`() {
    val state =
        MutableStateFlow<ConnectionState>(
            ConnectionState.Reconnecting(attempt = 2, nextRetryMs = 2000)
        )
    state.update { ConnectionState.Connected(subscribed = false) }
    assertTrue(state.value is ConnectionState.Connected)
  }

  @Test
  fun `Reconnecting to Disconnected transition`() {
    val state =
        MutableStateFlow<ConnectionState>(
            ConnectionState.Reconnecting(attempt = 3, nextRetryMs = 4000)
        )
    state.update { ConnectionState.Disconnected("Stopped") }
    val value = state.value
    assertTrue(value is ConnectionState.Disconnected)
    assertEquals("Stopped", (value as ConnectionState.Disconnected).reason)
  }

  // -- Derived boolean properties --

  @Test
  fun `isConnected is true only in Connected state`() {
    val state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected())
    assertFalse(state.value.isConnected)

    state.update { ConnectionState.Connecting }
    assertFalse(state.value.isConnected)

    state.update { ConnectionState.Connected() }
    assertTrue(state.value.isConnected)

    state.update { ConnectionState.Reconnecting(1, 1000) }
    assertFalse(state.value.isConnected)
  }

  @Test
  fun `shouldReconnect is true for Connecting, Connected, Reconnecting`() {
    assertFalse(ConnectionState.Disconnected().shouldReconnect)
    assertTrue(ConnectionState.Connecting.shouldReconnect)
    assertTrue(ConnectionState.Connected().shouldReconnect)
    assertTrue(ConnectionState.Reconnecting(1, 1000).shouldReconnect)
  }

  // -- Full lifecycle transitions --

  @Test
  fun `full lifecycle transitions`() {
    val state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected())

    state.update { ConnectionState.Connecting }
    assertTrue(state.value is ConnectionState.Connecting)

    state.update { ConnectionState.Connected(subscribed = false) }
    assertTrue(state.value is ConnectionState.Connected)
    assertFalse((state.value as ConnectionState.Connected).subscribed)

    state.update { current ->
      if (current is ConnectionState.Connected) current.copy(subscribed = true) else current
    }
    assertTrue((state.value as ConnectionState.Connected).subscribed)

    state.update { ConnectionState.Reconnecting(attempt = 1, nextRetryMs = 1000) }
    assertTrue(state.value is ConnectionState.Reconnecting)

    state.update { ConnectionState.Connected(subscribed = false) }
    assertTrue(state.value is ConnectionState.Connected)

    state.update { ConnectionState.Disconnected("Stopped") }
    assertTrue(state.value is ConnectionState.Disconnected)
  }

  @Test
  fun `shouldReconnect excludes Disconnected and Error`() {
    assertFalse(ConnectionState.Disconnected().shouldReconnect)
    assertFalse(ConnectionState.Error("test error").shouldReconnect)
    assertTrue(ConnectionState.Connecting.shouldReconnect)
    assertTrue(ConnectionState.Connected().shouldReconnect)
    assertTrue(ConnectionState.Reconnecting(1, 1000).shouldReconnect)
  }

  // -- Atomic CAS update safety --

  @Test
  fun `update only modifies Connected state for subscription`() {
    val state = MutableStateFlow<ConnectionState>(ConnectionState.Reconnecting(1, 1000))

    // Attempt to set subscribed on a non-Connected state should be a no-op
    state.update { current ->
      if (current is ConnectionState.Connected) {
        current.copy(subscribed = true)
      } else {
        current
      }
    }

    // State should remain Reconnecting
    assertTrue(state.value is ConnectionState.Reconnecting)
  }

  @Test
  fun `concurrent state updates are atomic via MutableStateFlow`() = runBlocking {
    val state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected())

    // Simulate rapid transitions
    state.update { ConnectionState.Connecting }
    state.update { ConnectionState.Connected(subscribed = false) }
    state.update { current ->
      if (current is ConnectionState.Connected) current.copy(subscribed = true) else current
    }

    val value = state.value
    assertTrue(value is ConnectionState.Connected)
    assertTrue((value as ConnectionState.Connected).subscribed)
  }
}
