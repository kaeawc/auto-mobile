package dev.jasonpearson.automobile.sdk.notifications

import dev.jasonpearson.automobile.sdk.NotificationAction
import kotlin.test.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Pins [AutoMobileNotificationReceiver.parseActions] against the malformed-entry cases that the
 * receiver has to tolerate, since notification action JSON arrives over a broadcast extra and is
 * not schema-validated before it gets here.
 *
 * Robolectric supplies a real `org.json` implementation; the android.jar stub on the plain
 * unit-test classpath would return default values instead of parsing.
 */
@RunWith(RobolectricTestRunner::class)
class AutoMobileNotificationReceiverTest {

  private val receiver = AutoMobileNotificationReceiver()

  @Test
  fun `parseActions returns actions in array order`() {
    val json =
      """[{"label":"Reply","actionId":"reply"},{"label":"Snooze","actionId":"snooze"}]"""
        .trimIndent()

    assertEquals(
      listOf(NotificationAction("Reply", "reply"), NotificationAction("Snooze", "snooze")),
      receiver.parseActions(json),
    )
  }

  @Test
  fun `parseActions skips null and non-object entries`() {
    // The null entry is the load-bearing case: it is what the removed `?: JSONObject()`
    // sentinel used to absorb by producing blank fields that the blank check then dropped.
    val json = """[{"label":"Reply","actionId":"reply"},null,"nonsense",42,["nested"]]"""

    assertEquals(listOf(NotificationAction("Reply", "reply")), receiver.parseActions(json))
  }

  @Test
  fun `parseActions drops entries with a blank label or actionId`() {
    val json =
      """
      [{"label":"","actionId":"a"},{"label":"B","actionId":""},
       {"label":"  ","actionId":"c"},{"label":"Keep","actionId":"keep"}]
      """
        .trimIndent()

    assertEquals(listOf(NotificationAction("Keep", "keep")), receiver.parseActions(json))
  }

  @Test
  fun `parseActions returns empty list for absent or malformed json`() {
    assertEquals(emptyList(), receiver.parseActions(null))
    assertEquals(emptyList(), receiver.parseActions(""))
    assertEquals(emptyList(), receiver.parseActions("   "))
    assertEquals(emptyList(), receiver.parseActions("{not valid json"))
    assertEquals(emptyList(), receiver.parseActions("[]"))
  }
}
