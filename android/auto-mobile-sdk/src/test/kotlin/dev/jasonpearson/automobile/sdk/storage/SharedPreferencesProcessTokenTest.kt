package dev.jasonpearson.automobile.sdk.storage

import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * The driver's listeners, queues and sequence counter are in-memory, so they restart with the app
 * process. [SharedPreferencesDriverImpl.processToken] is what lets CtrlProxy notice that (#10069):
 * it is stable for one driver and different for a freshly created one.
 */
@RunWith(RobolectricTestRunner::class)
class SharedPreferencesProcessTokenTest {

  @Test
  fun `token is stable for one driver and differs for a new one`() {
    val context = RuntimeEnvironment.getApplication()
    val first = SharedPreferencesDriverImpl(context)
    val second = SharedPreferencesDriverImpl(context)

    assertEquals(first.processToken, first.processToken)
    assertNotEquals(first.processToken, second.processToken)
  }
}
