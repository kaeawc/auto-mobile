package dev.jasonpearson.automobile.protoviewer

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SettingsStoreTest {
  @Test
  fun revocationEpochSurvivesRapidOffOnAndOnlyChangesOnRevocation() {
    val preferences =
      ApplicationProvider.getApplicationContext<Context>()
        .getSharedPreferences("network-revocations-test", Context.MODE_PRIVATE)
    preferences.edit().clear().commit()
    val store = SharedPreferencesSettingsStore(preferences)
    store.setAllowNetwork(false)
    assertEquals(0L, store.networkRevocations.value)
    store.setAllowNetwork(true)
    store.setAllowNetwork(true)
    assertEquals(0L, store.networkRevocations.value)
    store.setAllowNetwork(false)
    store.setAllowNetwork(true)
    assertEquals(1L, store.networkRevocations.value)
    assertTrue(store.allowNetwork.value)
    store.setAllowNetwork(false)
    assertEquals(2L, store.networkRevocations.value)
  }

  @Test
  fun defaultOffAndPersistsBothToggleDirections() {
    val preferences =
      ApplicationProvider.getApplicationContext<Context>()
        .getSharedPreferences("network-settings-test", Context.MODE_PRIVATE)
    preferences.edit().clear().commit()
    val store = SharedPreferencesSettingsStore(preferences)
    assertFalse(store.allowNetwork.value)
    store.setAllowNetwork(true)
    assertTrue(store.allowNetwork.value)
    val reopened = SharedPreferencesSettingsStore(preferences)
    assertTrue(reopened.allowNetwork.value)
    reopened.setAllowNetwork(false)
    assertFalse(SharedPreferencesSettingsStore(preferences).allowNetwork.value)
  }
}
