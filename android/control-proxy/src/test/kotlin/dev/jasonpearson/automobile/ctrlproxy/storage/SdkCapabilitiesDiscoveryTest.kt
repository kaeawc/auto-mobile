package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.ContentProviderClient
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.ProviderInfo
import android.net.Uri
import android.os.Bundle
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SdkCapabilitiesDiscoveryTest {
  private val context = mockk<Context>()
  private val manager = mockk<PackageManager>()
  private val resolver = mockk<ContentResolver>()
  private val authority = "com.example.automobile.capabilities"

  @Before
  fun setUp() {
    every { context.packageManager } returns manager
    every { context.contentResolver } returns resolver
  }

  private fun bridgeReturns(payload: String?) {
    every { manager.resolveContentProvider(authority, 0) } returns ProviderInfo()
    val bundle = payload?.let { Bundle().apply { putString("result", it) } }
    every { resolver.call(any<Uri>(), eq("snapshot"), null, null) } returns bundle
  }

  @Test
  fun `missing bridge is resolved from provider lookup without calling`() {
    every { manager.resolveContentProvider(authority, 0) } returns null
    val state = discoverSdkCapabilities(context, "com.example")
    assertEquals("unavailable", state.outcome)
    assertEquals("BRIDGE_NOT_INSTALLED", state.reason)
    verify(exactly = 0) { resolver.call(any<Uri>(), any(), any(), any()) }
  }

  @Test
  fun `present bridge forwards the snapshot verbatim including unknown fields`() {
    bridgeReturns(
      """{"schemaVersion":2,"capabilities":[{"id":"network.control","state":"DISABLED"}],"policy":{"captureHeaders":false,"captureBodies":true,"allowMutations":false},"future":1}"""
    )
    val state = discoverSdkCapabilities(context, "com.example")
    assertEquals("ok", state.outcome)
    assertNull(state.reason)
    assertEquals("2", state.snapshot!!.jsonObject.getValue("schemaVersion").jsonPrimitive.content)
    assertEquals("1", state.snapshot!!.jsonObject.getValue("future").jsonPrimitive.content)
    verify { resolver.call(Uri.parse("content://$authority"), "snapshot", null, null) }
  }

  @Test
  fun `missing result is bridge unavailable`() {
    bridgeReturns(null)
    assertEquals("BRIDGE_UNAVAILABLE", discoverSdkCapabilities(context, "com.example").reason)
  }

  @Test
  fun `malformed json is reported as malformed response`() {
    bridgeReturns("{not json")
    assertEquals("MALFORMED_RESPONSE", discoverSdkCapabilities(context, "com.example").reason)
  }

  @Test
  fun `non object snapshot is reported as malformed response`() {
    bridgeReturns("[1,2]")
    assertEquals("MALFORMED_RESPONSE", discoverSdkCapabilities(context, "com.example").reason)
  }

  @Test
  fun `provider failure is bridge unavailable`() {
    every { manager.resolveContentProvider(authority, 0) } returns ProviderInfo()
    every { resolver.call(any<Uri>(), any(), any(), any()) } throws SecurityException("denied")
    assertEquals("BRIDGE_UNAVAILABLE", discoverSdkCapabilities(context, "com.example").reason)
  }

  private val workProfileUri = Uri.parse("content://10@$authority")

  private fun crossUserPermission(granted: Boolean) {
    val result =
      if (granted) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED
    every { context.checkSelfPermission("android.permission.INTERACT_ACROSS_USERS") } returns result
    every {
      context.checkSelfPermission("android.permission.INTERACT_ACROSS_USERS_FULL")
    } returns PackageManager.PERMISSION_DENIED
  }

  @Test
  fun `own user id reads the local provider`() {
    bridgeReturns("""{"schemaVersion":1}""")
    val state = discoverSdkCapabilities(context, "com.example", userId = 0, serviceUserId = 0)
    assertEquals("ok", state.outcome)
    verify { resolver.call(Uri.parse("content://$authority"), "snapshot", null, null) }
  }

  @Test
  fun `another user without INTERACT_ACROSS_USERS is cross user unsupported`() {
    crossUserPermission(granted = false)
    val state = discoverSdkCapabilities(context, "com.example", userId = 10, serviceUserId = 0)
    assertEquals("unavailable", state.outcome)
    assertEquals("CROSS_USER_UNSUPPORTED", state.reason)
    verify(exactly = 0) { resolver.acquireUnstableContentProviderClient(any<Uri>()) }
    verify(exactly = 0) { resolver.call(any<Uri>(), any(), any(), any()) }
  }

  @Test
  fun `another user with INTERACT_ACROSS_USERS reads that user's provider`() {
    crossUserPermission(granted = true)
    val client = mockk<ContentProviderClient>(relaxUnitFun = true)
    every { resolver.acquireUnstableContentProviderClient(workProfileUri) } returns client
    every { client.call("snapshot", null, null) } returns
      Bundle().apply { putString("result", """{"schemaVersion":1}""") }
    val state = discoverSdkCapabilities(context, "com.example", userId = 10, serviceUserId = 0)
    assertEquals("ok", state.outcome)
    verify { client.close() }
    verify(exactly = 0) { manager.resolveContentProvider(any(), any<Int>()) }
  }

  @Test
  fun `another user without the bridge is bridge not installed`() {
    crossUserPermission(granted = true)
    every { resolver.acquireUnstableContentProviderClient(workProfileUri) } returns null
    val state = discoverSdkCapabilities(context, "com.example", userId = 10, serviceUserId = 0)
    assertEquals("BRIDGE_NOT_INSTALLED", state.reason)
  }
}
