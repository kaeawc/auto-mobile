package dev.jasonpearson.automobile.sdk.network

import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.os.Build
import dev.jasonpearson.automobile.sdk.SdkConstants
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.TIRAMISU])
class NetworkMockRuleStoreReceiverTest {

  @Test
  fun `network control receiver accepts current and legacy CtrlProxy permissions`() {
    assertEquals(
      listOf(
        "dev.jasonpearson.automobile.ctrlproxy.permission.NETWORK_CONTROL_V2",
        "dev.jasonpearson.automobile.sdk.permission.NETWORK_CONTROL",
      ),
      SdkConstants.NETWORK_CONTROL_PERMISSIONS,
    )
  }

  /**
   * Each permission needs a distinct receiver registration, while repeat initialization remains a
   * no-op and teardown unregisters every registration (#3599).
   */
  @Test
  fun `registerReceiver is idempotent and unregisters both permission receivers`() {
    val store = NetworkMockRuleStore()
    val context = mockk<Context>(relaxed = true)
    val currentReceiver = slot<BroadcastReceiver>()
    val legacyReceiver = slot<BroadcastReceiver>()
    every {
      context.registerReceiver(
        any<BroadcastReceiver>(),
        any<IntentFilter>(),
        SdkConstants.PERMISSION_NETWORK_CONTROL,
        null,
        Context.RECEIVER_EXPORTED,
      )
    } returns null
    every {
      context.registerReceiver(
        any<BroadcastReceiver>(),
        any<IntentFilter>(),
        SdkConstants.LEGACY_PERMISSION_NETWORK_CONTROL,
        null,
        Context.RECEIVER_EXPORTED,
      )
    } returns null

    store.registerReceiver(context)
    store.registerReceiver(context) // guarded no-op

    verify(exactly = 1) {
      context.registerReceiver(
        capture(currentReceiver),
        any<IntentFilter>(),
        SdkConstants.PERMISSION_NETWORK_CONTROL,
        null,
        Context.RECEIVER_EXPORTED,
      )
    }
    verify(exactly = 1) {
      context.registerReceiver(
        capture(legacyReceiver),
        any<IntentFilter>(),
        SdkConstants.LEGACY_PERMISSION_NETWORK_CONTROL,
        null,
        Context.RECEIVER_EXPORTED,
      )
    }
    assertNotSame(currentReceiver.captured, legacyReceiver.captured)

    store.unregisterReceiver(context)
    store.unregisterReceiver(context) // guarded no-op
    verify(exactly = 1) { context.unregisterReceiver(currentReceiver.captured) }
    verify(exactly = 1) { context.unregisterReceiver(legacyReceiver.captured) }

    // After unregister, both registrations can be restored.
    store.registerReceiver(context)
    verify(exactly = 2) {
      context.registerReceiver(
        any<BroadcastReceiver>(),
        any<IntentFilter>(),
        SdkConstants.PERMISSION_NETWORK_CONTROL,
        null,
        Context.RECEIVER_EXPORTED,
      )
    }
    verify(exactly = 2) {
      context.registerReceiver(
        any<BroadcastReceiver>(),
        any<IntentFilter>(),
        SdkConstants.LEGACY_PERMISSION_NETWORK_CONTROL,
        null,
        Context.RECEIVER_EXPORTED,
      )
    }
  }

  @Test
  fun `unregister without register is a no-op`() {
    val store = NetworkMockRuleStore()
    val context = mockk<Context>(relaxed = true)

    store.unregisterReceiver(context)

    verify(exactly = 0) { context.unregisterReceiver(any<BroadcastReceiver>()) }
  }
}
