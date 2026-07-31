package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure roll-up of daemon + per-device connection health into the workspace status dot. No Compose,
 * no I/O — plain values in, [WorkspaceStatusResult] out.
 */
class WorkspaceStatusDerivationTest {

  private val connected = ConnectionState.Connected()

  @Test
  fun `daemon connected with no devices is green`() {
    val result = deriveWorkspaceStatus(daemon = connected, devices = emptyList())
    assertEquals(WorkspaceStatus.Green, result.status)
    assertNull(result.detail)
  }

  @Test
  fun `daemon connected and all devices connected is green`() {
    val result =
      deriveWorkspaceStatus(daemon = connected, devices = listOf(connected, connected, connected))
    assertEquals(WorkspaceStatus.Green, result.status)
    assertNull(result.detail)
  }

  @Test
  fun `a connected-but-not-subscribed device still counts as healthy`() {
    val result =
      deriveWorkspaceStatus(
        daemon = connected,
        devices = listOf(ConnectionState.Connected(subscribed = false)),
      )
    assertEquals(WorkspaceStatus.Green, result.status)
    assertNull(result.detail)
  }

  @Test
  fun `daemon disconnected is red`() {
    val result =
      deriveWorkspaceStatus(daemon = ConnectionState.Disconnected(), devices = listOf(connected))
    assertEquals(WorkspaceStatus.Red, result.status)
    assertEquals("Daemon disconnected", result.detail)
  }

  @Test
  fun `daemon error is red`() {
    val result =
      deriveWorkspaceStatus(daemon = ConnectionState.Error("boom"), devices = listOf(connected))
    assertEquals(WorkspaceStatus.Red, result.status)
    assertEquals("Daemon error", result.detail)
  }

  @Test
  fun `daemon down overrides healthy devices`() {
    val result =
      deriveWorkspaceStatus(
        daemon = ConnectionState.Disconnected(),
        devices = listOf(connected, connected),
      )
    assertEquals(WorkspaceStatus.Red, result.status)
  }

  @Test
  fun `daemon connecting is yellow`() {
    val result = deriveWorkspaceStatus(daemon = ConnectionState.Connecting, devices = emptyList())
    assertEquals(WorkspaceStatus.Yellow, result.status)
    assertEquals("Daemon connecting", result.detail)
  }

  @Test
  fun `daemon reconnecting is yellow`() {
    val result =
      deriveWorkspaceStatus(
        daemon = ConnectionState.Reconnecting(attempt = 2, nextRetryMs = 1000),
        devices = listOf(connected),
      )
    assertEquals(WorkspaceStatus.Yellow, result.status)
    assertEquals("Daemon reconnecting", result.detail)
  }

  @Test
  fun `one offline device is yellow with a singular detail`() {
    val result =
      deriveWorkspaceStatus(
        daemon = connected,
        devices = listOf(connected, ConnectionState.Disconnected()),
      )
    assertEquals(WorkspaceStatus.Yellow, result.status)
    assertEquals("1 device offline", result.detail)
  }

  @Test
  fun `two offline devices is yellow with a plural detail`() {
    val result =
      deriveWorkspaceStatus(
        daemon = connected,
        devices = listOf(ConnectionState.Disconnected(), ConnectionState.Error("x")),
      )
    assertEquals(WorkspaceStatus.Yellow, result.status)
    assertEquals("2 devices offline", result.detail)
  }

  @Test
  fun `a device error counts as offline`() {
    val result =
      deriveWorkspaceStatus(daemon = connected, devices = listOf(ConnectionState.Error("x")))
    assertEquals(WorkspaceStatus.Yellow, result.status)
    assertEquals("1 device offline", result.detail)
  }

  @Test
  fun `one reconnecting device is yellow with a reconnecting detail`() {
    val result =
      deriveWorkspaceStatus(
        daemon = connected,
        devices = listOf(connected, ConnectionState.Reconnecting(attempt = 1, nextRetryMs = 500)),
      )
    assertEquals(WorkspaceStatus.Yellow, result.status)
    assertEquals("1 device reconnecting", result.detail)
  }

  @Test
  fun `a connecting device counts as reconnecting`() {
    val result =
      deriveWorkspaceStatus(daemon = connected, devices = listOf(ConnectionState.Connecting))
    assertEquals(WorkspaceStatus.Yellow, result.status)
    assertEquals("1 device reconnecting", result.detail)
  }

  @Test
  fun `offline wins the wording over reconnecting when both are present`() {
    val result =
      deriveWorkspaceStatus(
        daemon = connected,
        devices = listOf(ConnectionState.Disconnected(), ConnectionState.Connecting),
      )
    assertEquals(WorkspaceStatus.Yellow, result.status)
    assertEquals("1 device offline", result.detail)
  }
}
