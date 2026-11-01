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
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class KeystoreResetTest {
  private val context = mockk<Context>()
  private val manager = mockk<PackageManager>()
  private val resolver = mockk<ContentResolver>()

  @Before
  fun setUp() {
    every { context.packageManager } returns manager
    every { context.contentResolver } returns resolver
  }

  @Test
  fun `missing bridge never calls provider`() {
    every { manager.resolveContentProvider("com.example.automobile.keystore", 0) } returns null
    val result = resetKeystore(context, "com.example", "login", null)
    assertEquals("BRIDGE_NOT_INSTALLED", result.reason)
    assertEquals("login", result.requestedScope)
    assertNull(result.aliases)
    verify(exactly = 0) { resolver.call(any<Uri>(), any(), any(), any()) }
  }

  @Test
  fun `reset forwards exact selectors and returns typed outcomes`() {
    every { manager.resolveContentProvider(any(), 0) } returns ProviderInfo()
    every { resolver.call(any<Uri>(), eq("delete"), null, any()) } answers
      {
        val extras = arg<Bundle>(3)
        assertEquals("login", extras.getString("scope"))
        assertEquals("token", extras.getString("alias"))
        Bundle().apply {
          putString(
            "result",
            """{"outcome":"ok","bridgeAvailable":true,"requestedScope":"login","requestedAlias":"token","status":"deleted","deletedCount":1,"aliases":[{"alias":"token","outcome":"deleted"}]}""",
          )
        }
      }
    val result = resetKeystore(context, "com.example", "login", "token")
    assertEquals("deleted", result.status)
    assertEquals(1, result.deletedCount)
    assertEquals("token", result.aliases!!.single().alias)
    verify {
      resolver.call(Uri.parse("content://com.example.automobile.keystore"), "delete", null, any())
    }
  }

  @Test
  fun `provider exceptions and missing payload are structured unavailable`() {
    every { manager.resolveContentProvider(any(), 0) } returns ProviderInfo()
    every { resolver.call(any<Uri>(), eq("delete"), null, any()) } throws SecurityException()
    assertEquals("BRIDGE_UNAVAILABLE", resetKeystore(context, "com.example", null, "token").reason)
    every { resolver.call(any<Uri>(), eq("delete"), null, any()) } returns null
    assertEquals("BRIDGE_UNAVAILABLE", resetKeystore(context, "com.example", "login", null).reason)
  }
}
