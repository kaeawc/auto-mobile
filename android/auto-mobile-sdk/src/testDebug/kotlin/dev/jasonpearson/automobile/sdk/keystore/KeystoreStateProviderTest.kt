package dev.jasonpearson.automobile.sdk.keystore

import android.os.Bundle
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityState
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.shadows.ShadowBinder
import org.robolectric.shadows.ShadowLooper

@RunWith(RobolectricTestRunner::class)
internal class KeystoreStateProviderTest : KeystoreStateHandlerTestBase() {
  @Test
  fun `debug provider contributes a flat descriptor with explicit opt in after shutdown`() {
    AutoMobileSDK.shutdown()
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    try {
      val provider = KeystoreStateProvider()
      provider.onCreate()
      AutoMobileSDK.initialize(RuntimeEnvironment.getApplication())
      ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
      assertEquals(
        SdkCapabilityState.DISABLED,
        AutoMobileSDK.capabilities.capabilities.single { it.id == "storage.keystore" }.state,
      )
      KeystoreTestState.setEnabled(true)
      assertEquals(
        SdkCapabilityState.SUPPORTED,
        AutoMobileSDK.capabilities.capabilities.single { it.id == "storage.keystore" }.state,
      )
      assertTrue(
        AutoMobileSDK.capabilities.capabilities.none { it.id.startsWith("storage.keystore.") },
      )
      AutoMobileSDK.shutdown()
      ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
      ShadowBinder.setCallingUid(2000)
      provider.call("discover", null, null)
      assertTrue(AutoMobileSDK.capabilities.capabilities.any { it.id == "storage.keystore" })
    } finally {
      AutoMobileSDK.shutdown()
      ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    }
  }

  @Test(expected = SecurityException::class)
  fun `provider rejects unrelated caller before deleting`() {
    ShadowBinder.setCallingUid(10212)
    KeystoreStateProvider().call("delete", null, Bundle().apply { putString("scope", "fixture") })
  }

  @Test(expected = SecurityException::class)
  fun `provider rejects unrelated caller before handling even disabled discovery`() {
    ShadowBinder.setCallingUid(10212)
    KeystoreStateProvider().call("discover", null, Bundle())
  }

  @Test
  fun `provider uses a single json envelope`() {
    ShadowBinder.setCallingUid(2000)
    val result = KeystoreStateProvider().call("discover", null, null)
    assertEquals(setOf("result"), result.keySet())
    assertEquals(
      "disabled",
      JSONObject(requireNotNull(result.getString("result"))).getString("outcome"),
    )
  }
}
