package dev.jasonpearson.automobile.sdk.keystore

import android.os.Bundle
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityState
import java.security.KeyStoreException
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.shadows.ShadowBinder
import org.robolectric.shadows.ShadowLooper

@RunWith(RobolectricTestRunner::class)
class KeystoreStateHandlerTest {
  private class FakeKeystoreBackend : KeystoreBackend {
    val entries = mutableMapOf<String, EntryCategory>()
    val calls = mutableListOf<String>()
    var failure: Exception? = null

    override fun containsAlias(alias: String): Boolean {
      calls.add("containsAlias:$alias")
      failure?.let { throw it }
      return alias in entries
    }

    override fun entryCategory(alias: String): EntryCategory {
      calls.add("entryCategory:$alias")
      return entries.getValue(alias)
    }
  }

  private class FakeDeviceLockProbe(var locked: DeviceLockState = DeviceLockState.UNLOCKED) :
    DeviceLockProbe {
    var failure: Exception? = null
    var calls = 0

    override fun state(): DeviceLockState {
      calls++
      failure?.let { throw it }
      return locked
    }
  }

  private val backend = FakeKeystoreBackend()
  private val probe = FakeDeviceLockProbe()
  private val handler = KeystoreStateHandler(backend, probe)

  @Before
  fun setUp() {
    KeystoreTestState.reset()
  }

  @After
  fun tearDown() {
    KeystoreTestState.reset()
    ShadowBinder.reset()
  }

  private fun enable() {
    KeystoreTestState.declareScope("fixture", setOf("aes", "private", "cert", "unknown", "missing"))
    KeystoreTestState.setEnabled(true)
  }

  @Test
  fun `default disabled hides scopes and never touches backend or lock probe`() {
    KeystoreTestState.declareScope("fixture", setOf("aes"))
    val json = handler.handle("metadata", "fixture")
    assertEquals("disabled", json.getString("outcome"))
    assertEquals(0, json.getJSONArray("scopes").length())
    assertEquals(0, probe.calls)
    assertEquals("unknown", json.getString("deviceLocked"))
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `discovery reports metadata and unsupported mutation without opening store`() {
    enable()
    val json = handler.handle("discover")
    assertEquals("ok", json.getString("outcome"))
    assertEquals("storage.keystore", json.getString("capability"))
    assertTrue(json.getBoolean("bridgeAvailable"))
    assertEquals("supported", json.getString("metadata"))
    assertEquals("declared_unsupported", json.getString("mutation"))
    assertEquals("fixture", json.getJSONArray("scopes").getString(0))
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `contract metadata contains only alias presence and category`() {
    enable()
    backend.entries.putAll(
      mapOf(
        "aes" to EntryCategory.KEY,
        "private" to EntryCategory.PRIVATE_KEY,
        "cert" to EntryCategory.CERTIFICATE,
        "unknown" to EntryCategory.UNKNOWN,
      ),
    )
    val json = handler.handle("metadata", "fixture")
    val entries = json.getJSONArray("entries")
    assertEquals(5, entries.length())
    val byName =
      (0 until entries.length()).associate {
        entries.getJSONObject(it).let { entry -> entry.getString("alias") to entry }
      }
    backend.entries.forEach { (alias, category) ->
      assertEquals(category.name, byName.getValue(alias).getString("category"))
      assertTrue(byName.getValue(alias).getBoolean("present"))
    }
    assertFalse(byName.getValue("missing").getBoolean("present"))
    assertEquals("UNKNOWN", byName.getValue("missing").getString("category"))
    byName.values.forEach {
      assertEquals(setOf("alias", "present", "category"), it.keys().asSequence().toSet())
    }
    assertEquals(
      listOf(
        "containsAlias:aes",
        "entryCategory:aes",
        "containsAlias:cert",
        "entryCategory:cert",
        "containsAlias:missing",
        "containsAlias:private",
        "entryCategory:private",
        "containsAlias:unknown",
        "entryCategory:unknown",
      ),
      backend.calls,
    )
    assertEquals(
      setOf(
        "schemaVersion",
        "capability",
        "outcome",
        "bridgeAvailable",
        "metadata",
        "mutation",
        "deviceLocked",
        "scopes",
        "entries",
      ),
      json.keys().asSequence().toSet(),
    )
  }

  @Test
  fun `undeclared existing and missing aliases are indistinguishable without reads`() {
    enable()
    backend.entries["hidden"] = EntryCategory.SECRET_KEY
    assertEquals(
      handler.handle("metadata", "fixture", "hidden").toString(),
      handler.handle("metadata", "fixture", "absent").toString(),
    )
    assertEquals(
      "SCOPE_NOT_DECLARED",
      handler.handle("metadata", "fixture", "hidden").getString("reason"),
    )
    assertEquals(
      "SCOPE_NOT_DECLARED",
      handler.handle("metadata", "unknown", "aes").getString("reason"),
    )
    assertEquals("SCOPE_NOT_DECLARED", handler.handle("metadata", null, "aes").getString("reason"))
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `locked probe reports locked while still serving metadata`() {
    enable()
    probe.locked = DeviceLockState.LOCKED
    val json = handler.handle("metadata", "fixture", "aes")
    assertEquals("locked", json.getString("deviceLocked"))
    assertEquals("ok", json.getString("outcome"))
    assertEquals(listOf("containsAlias:aes"), backend.calls)
  }

  @Test
  fun `contract reserved exceptions map by type without leaking error messages`() {
    enable()
    listOf(KeyStoreException("secret"), ProviderException("secret")).forEach {
      backend.failure = it
      val json = handler.handle("metadata", "fixture", "aes")
      assertEquals("unavailable", json.getString("outcome"))
      assertFalse(json.toString().contains("secret"))
    }
    listOf(UserNotAuthenticatedException(), KeyPermanentlyInvalidatedException()).forEach {
      backend.failure = it
      assertEquals(
        "authentication_required",
        handler.handle("metadata", "fixture", "aes").getString("outcome"),
      )
    }
    backend.failure = UnrecoverableKeyException()
    probe.locked = DeviceLockState.LOCKED
    assertEquals("locked", handler.handle("metadata", "fixture", "aes").getString("outcome"))
    probe.locked = DeviceLockState.UNLOCKED
    assertEquals("unavailable", handler.handle("metadata", "fixture", "aes").getString("outcome"))
  }

  @Test
  fun `probe failure is unknown and does not block metadata`() {
    enable()
    probe.failure = SecurityException()
    val json = handler.handle("metadata", "fixture", "aes")
    assertEquals("unknown", json.getString("deviceLocked"))
    assertEquals("ok", json.getString("outcome"))
  }

  @Test
  fun `all unknown and mutation calls are unsupported without backend calls`() {
    listOf("delete", "reset", "set", "unknown").forEach {
      assertEquals("disabled", handler.handle(it).getString("outcome"))
    }
    enable()
    listOf("delete", "reset", "set", "unknown").forEach {
      assertEquals("unsupported", handler.handle(it).getString("outcome"))
    }
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `debug provider contributes a flat descriptor with explicit opt in after shutdown`() {
    AutoMobileSDK.shutdown()
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    try {
      val provider = KeystoreStateProvider()
      provider.onCreate()
      AutoMobileSDK.initialize(RuntimeEnvironment.getApplication())
      ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
      assertEquals(
        SdkCapabilityState.DISABLED,
        AutoMobileSDK.capabilities.capabilities.single { it.id == "storage.keystore" }.state,
      )
      KeystoreTestState.setEnabled(true)
      assertEquals(
        SdkCapabilityState.SUPPORTED,
        AutoMobileSDK.capabilities.capabilities.single { it.id == "storage.keystore" }.state,
      )
      assertTrue(
        AutoMobileSDK.capabilities.capabilities.none { it.id.startsWith("storage.keystore.") },
      )
      AutoMobileSDK.shutdown()
      ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
      ShadowBinder.setCallingUid(2000)
      provider.call("discover", null, null)
      assertTrue(AutoMobileSDK.capabilities.capabilities.any { it.id == "storage.keystore" })
    } finally {
      AutoMobileSDK.shutdown()
      ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    }
  }

  @Test(expected = SecurityException::class)
  fun `provider rejects unrelated caller before handling even disabled discovery`() {
    ShadowBinder.setCallingUid(10212)
    KeystoreStateProvider().call("discover", null, Bundle())
  }

  @Test
  fun `provider uses a single json envelope`() {
    ShadowBinder.setCallingUid(2000)
    val result = KeystoreStateProvider().call("discover", null, null)
    assertEquals(setOf("result"), result.keySet())
    assertEquals(
      "disabled",
      JSONObject(requireNotNull(result.getString("result"))).getString("outcome"),
    )
  }
}
