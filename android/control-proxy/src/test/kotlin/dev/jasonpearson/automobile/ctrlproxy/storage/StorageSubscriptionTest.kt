package dev.jasonpearson.automobile.ctrlproxy.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Unit tests for [StorageSubscription.parseId], the single canonical inverse of the
 * `"$packageName:$fileName"` subscriptionId format. Pure JVM — no Android, no Robolectric.
 *
 * This helper is shared by the inbound `unsubscribe_storage` dispatch and
 * [StorageSubscriptionManager.destroy], so pinning its behavior here guarantees both sites agree.
 */
class StorageSubscriptionTest {

  @Test
  fun `parseId inverts the format subscribe builds`() {
    // subscribe() sets subscriptionId = "$packageName:$fileName" by default.
    val subscription = StorageSubscription("com.example", "settings.xml")
    assertEquals("com.example:settings.xml", subscription.subscriptionId)
    assertEquals(
        "com.example" to "settings.xml",
        StorageSubscription.parseId(subscription.subscriptionId),
    )
  }

  @Test
  fun `parseId splits on the first colon only`() {
    // A file name may itself contain ':'; only the first ':' delimits packageName from fileName.
    assertEquals(
        "com.example" to "weird:name.xml",
        StorageSubscription.parseId("com.example:weird:name.xml"),
    )
  }

  @Test
  fun `parseId returns null when there is no colon`() {
    assertNull(StorageSubscription.parseId("nocolon"))
  }

  @Test
  fun `parseId returns null for an empty package segment`() {
    assertNull(StorageSubscription.parseId(":settings.xml"))
  }

  @Test
  fun `parseId returns null for an empty file segment`() {
    assertNull(StorageSubscription.parseId("com.example:"))
  }

  @Test
  fun `parseId returns null for a lone colon and empty string`() {
    assertNull(StorageSubscription.parseId(":"))
    assertNull(StorageSubscription.parseId(""))
  }
}
