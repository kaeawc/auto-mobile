package dev.jasonpearson.automobile.ctrlproxy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.test.core.app.ApplicationProvider
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.anr.AutoMobileAnr
import dev.jasonpearson.automobile.sdk.crashes.AutoMobileCrashes
import dev.jasonpearson.automobile.sdk.failures.AutoMobileFailures
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class ReceiverFiltersTest {
  private fun IntentFilter.actions() = (0 until countActions()).map { getAction(it) }

  @Test
  fun `each receiver listens for exactly its own broadcasts`() {
    assertEquals(listOf(CtrlProxy.ACTION_EXTRACT_HIERARCHY), ReceiverFilters.command().actions())
    assertEquals(
      listOf(AutoMobileSDK.ACTION_NAVIGATION_EVENT),
      ReceiverFilters.navigation().actions(),
    )
    assertEquals(
      listOf(SdkEventSerializer.ACTION_SDK_EVENT_BATCH),
      ReceiverFilters.eventBatch().actions(),
    )
    assertEquals(
      listOf(AutoMobileSDK.ACTION_RECOMPOSITION_SNAPSHOT),
      ReceiverFilters.recomposition().actions(),
    )
    assertEquals(
      listOf(AutoMobileSDK.ACTION_FRAME_METRICS_SNAPSHOT),
      ReceiverFilters.frameMetrics().actions(),
    )
    assertEquals(
      listOf(AutoMobileFailures.ACTION_HANDLED_EXCEPTION),
      ReceiverFilters.handledException().actions(),
    )
    assertEquals(listOf(AutoMobileCrashes.ACTION_CRASH), ReceiverFilters.crash().actions())
    assertEquals(listOf(AutoMobileAnr.ACTION_ANR), ReceiverFilters.anr().actions())
  }

  @Test
  fun `package changes are matched on the package data scheme`() {
    val filter = ReceiverFilters.packages()

    assertEquals(
      listOf(
        Intent.ACTION_PACKAGE_ADDED,
        Intent.ACTION_PACKAGE_REMOVED,
        Intent.ACTION_PACKAGE_REPLACED,
      ),
      filter.actions(),
    )
    assertEquals(1, filter.countDataSchemes())
    assertEquals("package", filter.getDataScheme(0))
  }

  private class Probe : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Unit
  }

  private fun registeredFlags(receiver: BroadcastReceiver): Int {
    val app = ApplicationProvider.getApplicationContext<android.app.Application>()
    return shadowOf(app).registeredReceivers.single { it.broadcastReceiver === receiver }.flags
  }

  @Test
  @Config(sdk = [33])
  fun `receivers for other processes are exported on Android 13 and later`() {
    val service = Robolectric.buildService(CtrlProxy::class.java).get()
    val receiver = Probe()

    service.registerExportedReceiver(receiver, ReceiverFilters.crash())

    assertEquals(
      Context.RECEIVER_EXPORTED,
      registeredFlags(receiver) and Context.RECEIVER_EXPORTED,
    )
  }

  @Test
  @Config(sdk = [30])
  fun `receivers register without a flag before Android 13`() {
    val service = Robolectric.buildService(CtrlProxy::class.java).get()
    val receiver = Probe()

    service.registerExportedReceiver(receiver, ReceiverFilters.crash())

    assertEquals(0, registeredFlags(receiver))
  }
}
