package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.ProviderInfo
import android.net.Uri
import android.os.Bundle
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class KeystoreDiscoveryTest {
  private val context = mockk<Context>()
  private val manager = mockk<PackageManager>()
  private val resolver = mockk<ContentResolver>()

  @Before
  fun setUp() {
    every { context.packageManager } returns manager
    every { context.contentResolver } returns resolver
  }

  @Test
  fun `missing bridge uses provider resolution without parsing error text`() {
    every { manager.resolveContentProvider("com.example.automobile.keystore", 0) } returns null
    val state = discoverKeystore(context, "com.example")
    assertEquals("BRIDGE_NOT_INSTALLED", state.reason)
    assertFalse(state.bridgeAvailable)
    verify(exactly = 0) { resolver.call(any<Uri>(), any(), any(), any()) }
  }

  @Test
  fun `present bridge forwards typed disabled state and strips unknown fields`() {
    every { manager.resolveContentProvider("com.example.automobile.keystore", 0) } returns
      ProviderInfo()
    val bundle =
      Bundle().apply {
        putString(
          "result",
          """{"schemaVersion":1,"capability":"storage.keystore","outcome":"disabled","reason":"DISABLED","bridgeAvailable":true,"metadata":"supported","mutation":"declared_unsupported","deviceLocked":"locked","scopes":[],"entries":[]}""",
        )
      }
    every { resolver.call(any<Uri>(), eq("discover"), null, null) } returns bundle
    val state = discoverKeystore(context, "com.example")
    assertEquals("disabled", state.outcome)
    assertEquals("DISABLED", state.reason)
    assertEquals("locked", state.deviceLocked)
    assertEquals("declared_unsupported", state.mutation)
    verify {
      resolver.call(Uri.parse("content://com.example.automobile.keystore"), "discover", null, null)
    }
  }

  @Test
  fun `transport exception is unavailable regardless of text`() {
    every { manager.resolveContentProvider("com.example.automobile.keystore", 0) } returns
      ProviderInfo()
    every { resolver.call(any<Uri>(), eq("discover"), null, null) } throws
      SecurityException("DISABLED unknown authority")
    assertEquals("BRIDGE_UNAVAILABLE", discoverKeystore(context, "com.example").reason)
  }
}
