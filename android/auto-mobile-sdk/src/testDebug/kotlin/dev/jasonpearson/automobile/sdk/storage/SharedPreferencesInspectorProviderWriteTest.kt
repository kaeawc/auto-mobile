package dev.jasonpearson.automobile.sdk.storage

import android.content.ContextWrapper
import android.content.SharedPreferences
import android.os.Bundle
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityDescriptor
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityState
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapturePolicy
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * Provider-level coverage for #10168: a mutation whose disk write fails must reach the caller as a
 * failure reply, not `OperationSuccess`.
 */
@RunWith(RobolectricTestRunner::class)
class SharedPreferencesInspectorProviderWriteTest {
  private val provider = SharedPreferencesInspectorProvider()
  private val fileName = "durable_prefs"
  private val storeName = "recording"
  private lateinit var prefs: RecordingSharedPreferences

  @Before
  fun setUp() {
    val base = RuntimeEnvironment.getApplication()
    AutoMobileSDK.initialize(base)
    AutoMobileSDK.registerCapability(
      SdkCapabilityDescriptor("storage.mutation", SdkCapabilityState.SUPPORTED),
    )
    AutoMobileSDK.updateCapturePolicy(SdkCapturePolicy(allowMutations = true))
    SharedPreferencesInspector.setEnabled(true)

    prefs = RecordingSharedPreferences(mapOf("existing" to "old"))
    val context =
      object : ContextWrapper(base) {
        override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences = prefs
      }
    val files = FakeFileSystemOperations()
    files.setFileExists(
      File(base.applicationInfo.dataDir, "shared_prefs/$fileName.xml").absolutePath,
      true,
    )
    SharedPreferencesInspector.registerDriver(
      storeName,
      SharedPreferencesDriverImpl(context, files, isMainThread = { false }),
    )
  }

  @After
  fun tearDown() {
    SharedPreferencesInspector.reset()
    AutoMobileSDK.shutdown()
  }

  private fun extras(vararg pairs: Pair<String, String>) =
    Bundle().apply {
      putString("storeName", storeName)
      putString("fileName", fileName)
      pairs.forEach { (k, v) -> putString(k, v) }
    }

  private val calls: Map<String, () -> Bundle> =
    mapOf(
      "setValue" to
        {
          provider.call(
            "setValue",
            null,
            extras("key" to "flag", "value" to "true", "type" to "BOOLEAN"),
          )
        },
      "removeValue" to { provider.call("removeValue", null, extras("key" to "existing")) },
      "clearFile" to { provider.call("clearFile", null, extras()) },
    )

  @Test
  fun `each mutation replies with a failure when the write does not reach disk`() {
    prefs.commitResult = false
    calls.forEach { (method, call) ->
      val result = call()

      assertFalse(method, result.getBoolean("success"))
      assertEquals(method, "WriteFailed", result.getString("errorType"))
      assertTrue(method, result.getString("error").orEmpty().contains(fileName))
    }
  }

  @Test
  fun `each mutation still replies with success when the write reaches disk`() {
    calls.forEach { (method, call) ->
      val result = call()

      assertTrue("$method: ${result.getString("error")}", result.getBoolean("success"))
    }
  }
}
