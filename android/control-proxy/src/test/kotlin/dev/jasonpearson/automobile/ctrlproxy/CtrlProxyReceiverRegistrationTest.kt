package dev.jasonpearson.automobile.ctrlproxy

import android.app.Application
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
}
