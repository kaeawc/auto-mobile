package dev.jasonpearson.automobile.sdk.network

import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.os.Build
import dev.jasonpearson.automobile.sdk.SdkConstants
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.TIRAMISU])
class NetworkMockRuleStoreReceiverTest {

  /**
   * The receiver must register at most once and unregister must allow a later re-register — without
   * the idempotency guard, re-init leaked/double-registered it so every broadcast was handled twice
   * (#3599).
   */
  @Test
  fun `registerReceiver is idempotent and unregister allows re-register`() {
    val store = NetworkMockRuleStore()
    val context = mockk<Context>(relaxed = true)
    every {
      context.registerReceiver(
        any<BroadcastReceiver>(),
        any<IntentFilter>(),
        SdkConstants.PERMISSION_NETWORK_CONTROL,
        any(),
        any<Int>(),
      )
    } returns null

    store.registerReceiver(context)
    store.registerReceiver(context) // guarded no-op

    verify(exactly = 1) {
      context.registerReceiver(
        any<BroadcastReceiver>(),
        any<IntentFilter>(),
        SdkConstants.PERMISSION_NETWORK_CONTROL,
        any(),
        any<Int>(),
      )
    }

    store.unregisterReceiver(context)
    verify(exactly = 1) { context.unregisterReceiver(any<BroadcastReceiver>()) }

    // After unregister, register works again (total of two registrations).
    store.registerReceiver(context)
    verify(exactly = 2) {
      context.registerReceiver(
        any<BroadcastReceiver>(),
        any<IntentFilter>(),
        SdkConstants.PERMISSION_NETWORK_CONTROL,
        any(),
        any<Int>(),
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
