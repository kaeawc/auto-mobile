package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpRequest
import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class NetworkSettingsTest {
  private val settings = FakeSettingsStore()
  private val permission = FakeLocalNetworkPermission()
  private val allowed = FakePrototypeHttpClient()

  @Test
  fun defaultOffDeniesWithoutConstructingTransport() = runBlocking {
    assertFalse(settings.allowNetwork.value)
    val client = SettingsPrototypeHttpClient(settings) { error("Transport created while disabled") }
    val response = client.execute(REQUEST) as PrototypeRequestResponse.Failed
    assertEquals(PrototypeRequestErrorCode.BLOCKED_DESTINATION, response.error.code)
  }

  @Test
  fun selectsInjectedClientForEveryRequestAcrossLiveToggles() = runBlocking {
    val client = SettingsPrototypeHttpClient(settings) { allowed }
    settings.setAllowNetwork(true)
    assertSame(allowed.response, client.execute(REQUEST))
    settings.setAllowNetwork(false)
    assertTrue(client.execute(REQUEST) is PrototypeRequestResponse.Failed)
    settings.setAllowNetwork(true)
    assertSame(allowed.response, client.execute(REQUEST))
    assertEquals(listOf(REQUEST, REQUEST), allowed.requests)
  }

  @Test
  fun permissionOnlyOnEnableAtApi37OrHigherAndDenialDisablesNetwork() {
    for (api in listOf(37, 38)) {
      val before = permission.requests
      val controller = NetworkSettings(settings, permission, api)
      assertEquals(before, permission.requests) // Construction never requests permission.
      controller.setEnabled(false)
      assertEquals(before, permission.requests)
      var granted: Boolean? = null
      permission.result = {
        granted = it
        controller.onPermissionResult(it)
      }
      controller.setEnabled(true)
      assertEquals(before + 1, permission.requests)
      assertEquals(false, granted)
      assertFalse(settings.allowNetwork.value)
      permission.granted = true
      controller.setEnabled(true)
      controller.setEnabled(false)
      assertEquals(before + 2, permission.requests)
      permission.granted = false
    }
  }

  @Test
  fun lateGrantAfterSwitchOffDoesNotReenableNetwork() {
    val controller = NetworkSettings(settings, permission, 37)
    permission.result = {} // Hold the platform result until after the user switches off.
    controller.setEnabled(true)
    controller.setEnabled(false)
    controller.onPermissionResult(true)
    assertFalse(settings.allowNetwork.value)
  }

  @Test
  fun lowerApisNeverRequestPermission() {
    for (api in listOf(26, 36)) {
      val controller = NetworkSettings(settings, permission, api)
      controller.setEnabled(true)
      assertTrue(settings.allowNetwork.value)
      controller.setEnabled(false)
    }
    assertEquals(0, permission.requests)
  }

  @Test
  fun grantingPermissionKeepsNetworkEnabledAndReenableCanRequestAgain() {
    permission.granted = true
    val controller = NetworkSettings(settings, permission, 37)
    repeat(2) {
      permission.result = {
        controller.onPermissionResult(it)
        assertTrue(it)
      }
      controller.setEnabled(true)
      controller.setEnabled(true)
      assertTrue(settings.allowNetwork.value)
      controller.setEnabled(false)
    }
    assertEquals(2, permission.requests)
  }

  @Test
  fun revokedGrantTurnsEnabledSwitchOffAndReportsRevocation() {
    val grant = FakeLocalNetworkGrant(granted = false)
    settings.setAllowNetwork(true)
    val context = ApplicationProvider.getApplicationContext<Context>()
    assertTrue(revokeNetworkIfLocalNetworkLost(settings, grant, context))
    assertFalse(settings.allowNetwork.value)
    assertEquals(1L, settings.networkRevocations.value)
  }

  @Test
  fun grantedOrAlreadyOffLeavesSettingsUntouched() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    settings.setAllowNetwork(true)
    assertFalse(revokeNetworkIfLocalNetworkLost(settings, FakeLocalNetworkGrant(true), context))
    assertTrue(settings.allowNetwork.value)
    settings.setAllowNetwork(false)
    val denied = FakeLocalNetworkGrant(false)
    assertFalse(revokeNetworkIfLocalNetworkLost(settings, denied, context))
    assertFalse(settings.allowNetwork.value)
    assertEquals(0, denied.checks) // Nothing to revoke: no platform query while the switch is off.
  }

  private companion object {
    val REQUEST =
      PrototypeHttpRequest(
        "request",
        "prototype",
        "GET",
        "https://example.test",
        emptyMap(),
        null,
        1000,
      )
  }
}
