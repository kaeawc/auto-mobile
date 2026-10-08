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
}
