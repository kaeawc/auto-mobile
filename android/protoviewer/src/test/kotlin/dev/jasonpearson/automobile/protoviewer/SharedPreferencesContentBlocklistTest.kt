package dev.jasonpearson.automobile.protoviewer

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SharedPreferencesContentBlocklistTest {
  private val preferences =
    ApplicationProvider.getApplicationContext<Context>()
      .getSharedPreferences("blocklist-test", Context.MODE_PRIVATE)
      .also { it.edit().clear().commit() }

  @Test
  fun startsEmptyAndPersistsHiddenHashesAndBlockedHosts() {
    val store = SharedPreferencesContentBlocklist(preferences)
    assertTrue(store.hiddenSpecHashes().isEmpty())
    assertTrue(store.blockedHosts().isEmpty())
    store.hide("a".repeat(64))
    store.hide("b".repeat(64))
    store.block("proto.example.com")
    val reopened = SharedPreferencesContentBlocklist(preferences)
    assertEquals(setOf("a".repeat(64), "b".repeat(64)), reopened.hiddenSpecHashes())
    assertEquals(setOf("proto.example.com"), reopened.blockedHosts())
  }

  @Test
  fun rejectsValuesThatAreNotAHashOrHost() {
    val store = SharedPreferencesContentBlocklist(preferences)
    assertThrows(IllegalArgumentException::class.java) { store.hide("not-a-hash") }
    assertThrows(IllegalArgumentException::class.java) { store.block("Example.COM:80") }
    assertTrue(store.hiddenSpecHashes().isEmpty())
    assertTrue(store.blockedHosts().isEmpty())
  }
}
