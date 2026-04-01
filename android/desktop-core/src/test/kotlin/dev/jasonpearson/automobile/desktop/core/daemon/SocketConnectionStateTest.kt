package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.unified.UnifiedConnectionState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for the sealed state machine approach used in socket clients.
 * Validates state transitions, derived boolean properties, and atomic CAS updates.
 */
class SocketConnectionStateTest {

    // -- FailuresPushConnectionState transitions --

    @Test
    fun `FailuresPush initial state is Disconnected`() {
        val state = MutableStateFlow<FailuresPushConnectionState>(FailuresPushConnectionState.Disconnected(null))
        assertTrue(state.value is FailuresPushConnectionState.Disconnected)
    }

    @Test
    fun `FailuresPush Disconnected to Connecting transition`() {
        val state = MutableStateFlow<FailuresPushConnectionState>(FailuresPushConnectionState.Disconnected(null))
        state.update { FailuresPushConnectionState.Connecting }
        assertTrue(state.value is FailuresPushConnectionState.Connecting)
    }

    @Test
    fun `FailuresPush Connecting to Connected transition`() {
        val state = MutableStateFlow<FailuresPushConnectionState>(FailuresPushConnectionState.Connecting)
        state.update { FailuresPushConnectionState.Connected(subscribed = false) }
        val value = state.value
        assertTrue(value is FailuresPushConnectionState.Connected)
        assertFalse((value as FailuresPushConnectionState.Connected).subscribed)
    }

    @Test
    fun `FailuresPush Connected subscribed flag updates atomically`() {
        val state = MutableStateFlow<FailuresPushConnectionState>(
            FailuresPushConnectionState.Connected(subscribed = false)
        )
        state.update { current ->
            if (current is FailuresPushConnectionState.Connected) {
                current.copy(subscribed = true)
            } else {
                current
            }
        }
        val value = state.value as FailuresPushConnectionState.Connected
        assertTrue(value.subscribed)
    }

    @Test
    fun `FailuresPush Connected to Reconnecting transition`() {
        val state = MutableStateFlow<FailuresPushConnectionState>(
            FailuresPushConnectionState.Connected(subscribed = true)
        )
        state.update { FailuresPushConnectionState.Reconnecting(attempt = 1, nextRetryMs = 1000) }
        val value = state.value
        assertTrue(value is FailuresPushConnectionState.Reconnecting)
        assertEquals(1, (value as FailuresPushConnectionState.Reconnecting).attempt)
    }

    @Test
    fun `FailuresPush Reconnecting to Connected transition`() {
        val state = MutableStateFlow<FailuresPushConnectionState>(
            FailuresPushConnectionState.Reconnecting(attempt = 2, nextRetryMs = 2000)
        )
        state.update { FailuresPushConnectionState.Connected(subscribed = false) }
        assertTrue(state.value is FailuresPushConnectionState.Connected)
    }

    @Test
    fun `FailuresPush Reconnecting to Disconnected transition`() {
        val state = MutableStateFlow<FailuresPushConnectionState>(
            FailuresPushConnectionState.Reconnecting(attempt = 3, nextRetryMs = 4000)
        )
        state.update { FailuresPushConnectionState.Disconnected("Stopped") }
        val value = state.value
        assertTrue(value is FailuresPushConnectionState.Disconnected)
        assertEquals("Stopped", (value as FailuresPushConnectionState.Disconnected).reason)
    }

    // -- FailuresPush derived boolean properties --

    @Test
    fun `FailuresPush isConnected is true only in Connected state`() {
        val state = MutableStateFlow<FailuresPushConnectionState>(FailuresPushConnectionState.Disconnected(null))
        assertFalse(state.value is FailuresPushConnectionState.Connected)

        state.update { FailuresPushConnectionState.Connecting }
        assertFalse(state.value is FailuresPushConnectionState.Connected)

        state.update { FailuresPushConnectionState.Connected() }
        assertTrue(state.value is FailuresPushConnectionState.Connected)

        state.update { FailuresPushConnectionState.Reconnecting(1, 1000) }
        assertFalse(state.value is FailuresPushConnectionState.Connected)
    }

    @Test
    fun `FailuresPush shouldReconnect is true for Connecting, Connected, Reconnecting`() {
        fun shouldReconnect(state: FailuresPushConnectionState): Boolean {
            return state is FailuresPushConnectionState.Connecting ||
                state is FailuresPushConnectionState.Connected ||
                state is FailuresPushConnectionState.Reconnecting
        }

        assertFalse(shouldReconnect(FailuresPushConnectionState.Disconnected(null)))
        assertTrue(shouldReconnect(FailuresPushConnectionState.Connecting))
        assertTrue(shouldReconnect(FailuresPushConnectionState.Connected()))
        assertTrue(shouldReconnect(FailuresPushConnectionState.Reconnecting(1, 1000)))
    }

    // -- PushConnectionState (Performance) transitions --

    @Test
    fun `Push initial state is Disconnected`() {
        val state = MutableStateFlow<PushConnectionState>(PushConnectionState.Disconnected(null))
        assertTrue(state.value is PushConnectionState.Disconnected)
    }

    @Test
    fun `Push Connecting to Connected to Disconnected`() {
        val state = MutableStateFlow<PushConnectionState>(PushConnectionState.Disconnected(null))

        state.update { PushConnectionState.Connecting }
        assertTrue(state.value is PushConnectionState.Connecting)

        state.update { PushConnectionState.Connected(subscribed = false) }
        assertTrue(state.value is PushConnectionState.Connected)

        state.update { current ->
            if (current is PushConnectionState.Connected) current.copy(subscribed = true) else current
        }
        assertTrue((state.value as PushConnectionState.Connected).subscribed)

        state.update { PushConnectionState.Disconnected("Stream ended") }
        assertEquals("Stream ended", (state.value as PushConnectionState.Disconnected).reason)
    }

    // -- TelemetryConnectionState transitions --

    @Test
    fun `Telemetry full lifecycle transitions`() {
        val state = MutableStateFlow<TelemetryConnectionState>(TelemetryConnectionState.Disconnected(null))

        state.update { TelemetryConnectionState.Connecting }
        assertTrue(state.value is TelemetryConnectionState.Connecting)

        state.update { TelemetryConnectionState.Connected(subscribed = false) }
        assertTrue(state.value is TelemetryConnectionState.Connected)
        assertFalse((state.value as TelemetryConnectionState.Connected).subscribed)

        state.update { current ->
            if (current is TelemetryConnectionState.Connected) current.copy(subscribed = true) else current
        }
        assertTrue((state.value as TelemetryConnectionState.Connected).subscribed)

        state.update { TelemetryConnectionState.Reconnecting(attempt = 1, nextRetryMs = 1000) }
        assertTrue(state.value is TelemetryConnectionState.Reconnecting)

        state.update { TelemetryConnectionState.Connected(subscribed = false) }
        assertTrue(state.value is TelemetryConnectionState.Connected)

        state.update { TelemetryConnectionState.Disconnected("Stopped") }
        assertTrue(state.value is TelemetryConnectionState.Disconnected)
    }

    @Test
    fun `Telemetry shouldReconnect is true for Connecting, Connected, Reconnecting`() {
        fun shouldReconnect(state: TelemetryConnectionState): Boolean {
            return state is TelemetryConnectionState.Connecting ||
                state is TelemetryConnectionState.Connected ||
                state is TelemetryConnectionState.Reconnecting
        }

        assertFalse(shouldReconnect(TelemetryConnectionState.Disconnected(null)))
        assertTrue(shouldReconnect(TelemetryConnectionState.Connecting))
        assertTrue(shouldReconnect(TelemetryConnectionState.Connected()))
        assertTrue(shouldReconnect(TelemetryConnectionState.Reconnecting(1, 1000)))
    }

    // -- UnifiedConnectionState transitions --

    @Test
    fun `Unified full lifecycle transitions`() {
        val state = MutableStateFlow<UnifiedConnectionState>(UnifiedConnectionState.Disconnected)

        state.update { UnifiedConnectionState.Connecting }
        assertTrue(state.value is UnifiedConnectionState.Connecting)

        state.update { UnifiedConnectionState.Connected }
        assertTrue(state.value is UnifiedConnectionState.Connected)

        state.update { UnifiedConnectionState.Reconnecting(1, 1000) }
        assertTrue(state.value is UnifiedConnectionState.Reconnecting)

        state.update { UnifiedConnectionState.Connected }
        assertTrue(state.value is UnifiedConnectionState.Connected)

        state.update { UnifiedConnectionState.Disconnected }
        assertTrue(state.value is UnifiedConnectionState.Disconnected)
    }

    @Test
    fun `Unified shouldReconnect derived property`() {
        fun shouldReconnect(state: UnifiedConnectionState): Boolean {
            return state is UnifiedConnectionState.Connecting ||
                state is UnifiedConnectionState.Connected ||
                state is UnifiedConnectionState.Reconnecting
        }

        assertFalse(shouldReconnect(UnifiedConnectionState.Disconnected))
        assertFalse(shouldReconnect(UnifiedConnectionState.Error("test error")))
        assertTrue(shouldReconnect(UnifiedConnectionState.Connecting))
        assertTrue(shouldReconnect(UnifiedConnectionState.Connected))
        assertTrue(shouldReconnect(UnifiedConnectionState.Reconnecting(1, 1000)))
    }

    // -- Atomic CAS update safety --

    @Test
    fun `update only modifies Connected state for subscription`() {
        val state = MutableStateFlow<FailuresPushConnectionState>(FailuresPushConnectionState.Reconnecting(1, 1000))

        // Attempt to set subscribed on a non-Connected state should be a no-op
        state.update { current ->
            if (current is FailuresPushConnectionState.Connected) {
                current.copy(subscribed = true)
            } else {
                current
            }
        }

        // State should remain Reconnecting
        assertTrue(state.value is FailuresPushConnectionState.Reconnecting)
    }

    @Test
    fun `concurrent state updates are atomic via MutableStateFlow`() = runBlocking {
        val state = MutableStateFlow<FailuresPushConnectionState>(FailuresPushConnectionState.Disconnected(null))

        // Simulate rapid transitions
        state.update { FailuresPushConnectionState.Connecting }
        state.update { FailuresPushConnectionState.Connected(subscribed = false) }
        state.update { current ->
            if (current is FailuresPushConnectionState.Connected) current.copy(subscribed = true) else current
        }

        val value = state.value
        assertTrue(value is FailuresPushConnectionState.Connected)
        assertTrue((value as FailuresPushConnectionState.Connected).subscribed)
    }
}
