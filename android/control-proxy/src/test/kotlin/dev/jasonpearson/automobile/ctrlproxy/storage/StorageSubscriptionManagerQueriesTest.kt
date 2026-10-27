package dev.jasonpearson.automobile.ctrlproxy.storage

import android.net.Uri
import android.os.Bundle
import io.mockk.every
import io.mockk.slot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class StorageSubscriptionManagerQueriesTest : StorageSubscriptionManagerFixtures() {
  // ================= SDK Availability Tests =================

  @Test
  fun `checkSdkAvailability returns failure when SDK not installed`() {
    every { contentResolver.call(any<Uri>(), any(), any(), any()) } returns null

    val result = manager.checkSdkAvailability("com.example.app")

    assertTrue(result.isFailure)
    assertTrue(result.exceptionOrNull() is StorageError.SdkNotInstalled)
  }

  @Test
  fun `checkSdkAvailability returns failure when inspection disabled`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", false)
        putString("errorType", "DISABLED")
        putString("error", "Inspection is disabled")
      }
    every { contentResolver.call(any<Uri>(), eq("checkAvailability"), any(), any()) } returns bundle

    val result = manager.checkSdkAvailability("com.example.app")

    assertTrue(result.isFailure)
    assertTrue(result.exceptionOrNull() is StorageError.InspectionDisabled)
  }

  @Test
  fun `checkSdkAvailability returns success with version info`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        // Response uses kotlinx.serialization sealed class format with type discriminator
        putString("result", """{"type":"availability","available":true,"version":1}""")
      }
    every { contentResolver.call(any<Uri>(), eq("checkAvailability"), any(), any()) } returns bundle

    val result = manager.checkSdkAvailability("com.example.app")

    assertTrue(result.isSuccess)
    val info = result.getOrNull()!!
    assertTrue(info.available)
    assertEquals(1, info.version)
  }

  // ================= List Preference Files Tests =================

  @Test
  fun `listPreferenceFiles returns files on success`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        // Response uses kotlinx.serialization sealed class format with type discriminator
        putString(
          "result",
          """{"type":"files","files":[{"name":"auth","path":"/data/auth.xml","entryCount":5},{"name":"settings","path":"/data/settings.xml","entryCount":3}]}""",
        )
      }
    every { contentResolver.call(any<Uri>(), eq("listFiles"), any(), any()) } returns bundle

    val result = manager.listPreferenceFiles("com.example.app")

    assertTrue(result.isSuccess)
    val files = result.getOrNull()!!
    assertEquals(2, files.size)
    assertEquals("auth", files[0].name)
    assertEquals(5, files[0].entryCount)
    assertEquals("settings", files[1].name)
    assertEquals(3, files[1].entryCount)
  }

  @Test
  fun `listPreferenceFiles returns failure when SDK not installed`() {
    every { contentResolver.call(any<Uri>(), eq("listFiles"), any(), any()) } returns null

    val result = manager.listPreferenceFiles("com.example.app")

    assertTrue(result.isFailure)
    assertTrue(result.exceptionOrNull() is StorageError.SdkNotInstalled)
  }

  // ================= Get Preferences Tests =================

  @Test
  fun `getPreferences returns entries on success`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        // Response uses kotlinx.serialization sealed class format with type discriminator
        putString(
          "result",
          """{"type":"preferences","entries":[{"key":"username","value":"john","type":"STRING"},{"key":"count","value":"42","type":"INT"}]}""",
        )
      }
    every { contentResolver.call(any<Uri>(), eq("getPreferences"), any(), any()) } returns bundle

    val result = manager.getPreferences("com.example.app", "auth")

    assertTrue(result.isSuccess)
    val entries = result.getOrNull()!!
    assertEquals(2, entries.size)
    assertEquals("username", entries[0].key)
    assertEquals("john", entries[0].value)
    assertEquals("STRING", entries[0].type)
    assertEquals("count", entries[1].key)
    assertEquals("42", entries[1].value)
    assertEquals("INT", entries[1].type)
  }

  @Test
  fun `getPreferences returns failure for missing file`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", false)
        putString("errorType", "FileNotFound")
        putString("error", "File not found")
      }
    every { contentResolver.call(any<Uri>(), eq("getPreferences"), any(), any()) } returns bundle

    val result = manager.getPreferences("com.example.app", "nonexistent")

    assertTrue(result.isFailure)
    assertTrue(result.exceptionOrNull() is StorageError.FileNotFound)
  }

  // ================= DataStore Tests =================

  @Test
  fun `listDataStores returns descriptors and passes adapterName`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        // DataStore descriptors reuse the shared FileList shape (path emitted empty).
        putString(
          "result",
          """{"type":"files","files":[{"name":"user_prefs","path":"","entryCount":2}]}""",
        )
      }
    val extrasSlot = slot<Bundle>()
    every {
      contentResolver.call(any<Uri>(), eq("listDataStores"), any(), capture(extrasSlot))
    } returns bundle

    val result = manager.listDataStores("com.example.app", "settings")

    assertTrue(result.isSuccess)
    val files = result.getOrNull()!!
    assertEquals(1, files.size)
    assertEquals("user_prefs", files[0].name)
    assertEquals(2, files[0].entryCount)
    assertEquals("settings", extrasSlot.captured.getString("adapterName"))
  }

  @Test
  fun `listDataStores returns failure when SDK not installed`() {
    every { contentResolver.call(any<Uri>(), eq("listDataStores"), any(), any()) } returns null

    val result = manager.listDataStores("com.example.app", "settings")

    assertTrue(result.isFailure)
    assertTrue(result.exceptionOrNull() is StorageError.SdkNotInstalled)
  }

  @Test
  fun `getDataStore returns entries and passes adapterName and storeName`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", true)
        putString(
          "result",
          """{"type":"preferences","entries":[{"key":"theme","value":"dark","type":"STRING"}]}""",
        )
      }
    val extrasSlot = slot<Bundle>()
    every {
      contentResolver.call(any<Uri>(), eq("getDataStore"), any(), capture(extrasSlot))
    } returns bundle

    val result = manager.getDataStore("com.example.app", "settings", "user_prefs")

    assertTrue(result.isSuccess)
    val entries = result.getOrNull()!!
    assertEquals(1, entries.size)
    assertEquals("theme", entries[0].key)
    assertEquals("dark", entries[0].value)
    assertEquals("STRING", entries[0].type)
    assertEquals("settings", extrasSlot.captured.getString("adapterName"))
    assertEquals("user_prefs", extrasSlot.captured.getString("storeName"))
  }

  @Test
  fun `getDataStore maps StoreNotFound to FileNotFound`() {
    val bundle =
      Bundle().apply {
        putBoolean("success", false)
        putString("errorType", "StoreNotFound")
        putString("error", "Store not found")
      }
    every { contentResolver.call(any<Uri>(), eq("getDataStore"), any(), any()) } returns bundle

    val result = manager.getDataStore("com.example.app", "settings", "missing")

    assertTrue(result.isFailure)
    assertTrue(result.exceptionOrNull() is StorageError.FileNotFound)
  }

  @Test
  fun `provider null pointer failure becomes a typed storage error`() {
    every { contentResolver.call(any<Uri>(), eq("listFiles"), any(), any()) } throws
      NullPointerException("provider failed through Binder")

    val result = manager.listPreferenceFiles("com.example.app")

    assertTrue(result.exceptionOrNull() is StorageError.SdkError)
  }
}
