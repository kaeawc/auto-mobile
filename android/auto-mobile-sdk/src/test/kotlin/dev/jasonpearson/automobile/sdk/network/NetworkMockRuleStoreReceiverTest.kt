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
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.TIRAMISU])
class NetworkMockRuleStoreReceiverTest {

  @Test
  fun `network control receiver accepts only CtrlProxy owned V2 permission`() {
    assertEquals(
      "dev.jasonpearson.automobile.ctrlproxy.permission.NETWORK_CONTROL_V2",
      SdkConstants.PERMISSION_NETWORK_CONTROL,
    )
  }

  /** Repeat initialization remains a no-op and teardown unregisters the receiver (#3599). */
  @Test
  fun `registerReceiver is idempotent and unregister allows re-register`() {
    val store = NetworkMockRuleStore()
    val context = mockk<Context>(relaxed = true)
    val receiver = slot<BroadcastReceiver>()
    every {
      context.registerReceiver(
        any<BroadcastReceiver>(),
        any<IntentFilter>(),
        SdkConstants.PERMISSION_NETWORK_CONTROL,
        null,
        Context.RECEIVER_EXPORTED,
      )
    } returns null

    store.registerReceiver(context)
    store.registerReceiver(context) // guarded no-op

    verify(exactly = 1) {
      context.registerReceiver(
        capture(receiver),
        any<IntentFilter>(),
        SdkConstants.PERMISSION_NETWORK_CONTROL,
        null,
        Context.RECEIVER_EXPORTED,
      )
    }

    store.unregisterReceiver(context)
    store.unregisterReceiver(context) // guarded no-op
    verify(exactly = 1) { context.unregisterReceiver(receiver.captured) }

    // After unregister, registration can be restored.
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
  }

  @Test
  fun `unregister without register is a no-op`() {
    val store = NetworkMockRuleStore()
    val context = mockk<Context>(relaxed = true)

    store.unregisterReceiver(context)

    verify(exactly = 0) { context.unregisterReceiver(any<BroadcastReceiver>()) }
  }
}
