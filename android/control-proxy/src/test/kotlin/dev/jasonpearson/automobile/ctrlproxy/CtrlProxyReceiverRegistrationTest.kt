package dev.jasonpearson.automobile.ctrlproxy

import android.app.Application
import android.content.Intent
import android.content.IntentFilter
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Every receiver the service registers is released again, from one shared list. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CtrlProxyReceiverRegistrationTest {
  private val app = ApplicationProvider.getApplicationContext<Application>()
  private val service: CtrlProxy = Robolectric.buildService(CtrlProxy::class.java).get()

  private fun registered() = shadowOf(app).registeredReceivers.map { it.broadcastReceiver }

  @Test
  fun `registration adds ten distinct receivers and teardown removes all of them`() {
    val before = registered()

    service.registerReceivers()
    val added = registered() - before.toSet()

    assertEquals("ten receivers, each registered once", 10, added.size)
    assertEquals(added.size, added.toSet().size)

    service.unregisterReceivers()

    assertTrue("teardown leaves none behind", registered().none { it in added })
    assertEquals(before, registered())
  }

  private fun IntentFilter.actions() = (0 until countActions()).map { getAction(it) }

  @Test
  fun `each receiver is registered with its own filter`() {
    val before = registered().toSet()

    service.registerReceivers()
    val actionsByReceiver =
      shadowOf(app)
        .registeredReceivers
        .filter { it.broadcastReceiver !in before }
        .associate { it.broadcastReceiver::class to it.intentFilter.actions() }

    assertEquals(
      mapOf(
        CommandReceiver::class to ReceiverFilters.command().actions(),
        NavigationEventReceiver::class to ReceiverFilters.navigation().actions(),
        EventBatchReceiver::class to ReceiverFilters.eventBatch().actions(),
        RecompositionSnapshotReceiver::class to ReceiverFilters.recomposition().actions(),
        FrameMetricsSnapshotReceiver::class to ReceiverFilters.frameMetrics().actions(),
        PackageEventReceiver::class to ReceiverFilters.packages().actions(),
        HandledExceptionReceiver::class to ReceiverFilters.handledException().actions(),
        CrashReceiver::class to ReceiverFilters.crash().actions(),
        AnrReceiver::class to ReceiverFilters.anr().actions(),
        ScreenStateReceiver::class to
          listOf(Intent.ACTION_SCREEN_ON, Intent.ACTION_SCREEN_OFF, Intent.ACTION_USER_PRESENT),
      ),
      actionsByReceiver,
    )
    // PackageEventReceiver reads intent.data, so its registered filter must keep the scheme.
    val packageFilter =
      shadowOf(app)
        .registeredReceivers
        .single { it.broadcastReceiver !in before && it.broadcastReceiver is PackageEventReceiver }
        .intentFilter
    assertEquals(
      listOf("package"),
      (0 until packageFilter.countDataSchemes()).map { packageFilter.getDataScheme(it) },
    )
    service.unregisterReceivers()
  }
}
