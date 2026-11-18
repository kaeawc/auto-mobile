package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import java.io.IOException
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeSecureStorageTest {
  companion object {
    private const val SECRET = "private-token-14321"

    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val plain = MemoryPlainStore()
  private val secure = MemorySecureStore()
  private val warnings = mutableListOf<String>()
  private val scheduler = PrototypeScheduler { _, _ -> PrototypeScheduledTask {} }

  private fun persistence(
    io: CoroutineContext = EmptyCoroutineContext,
    registry: PrototypeStorageSessionRegistry? = null,
  ) =
    PrototypeStoragePersistence(
      PrototypeStorageBackends(plain, secure),
      scheduler,
      io,
      warn =
        PrototypeStorageWarn { message, cause ->
          warnings += message
          assertNull(cause)
        },
      registry = registry,
    )

  private fun spec(id: String = "vault", version: Int = 1): PrototypeSpec {
    val result =
      PrototypeSpecValidator.validate(
        """{"id":"$id","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["secureStorage","biometric"]},"state":{"token":"","pin":"","count":0},"storage":{"version":$version,"keys":["state:count"],"secure":["state:token","state:pin"],"secureAuth":{"state:pin":"biometric"}},"root":{"type":"text","text":"Vault"}}""",
      )
    return (result as PrototypeSpecValidation.Success).spec
  }

  private fun changed(spec: PrototypeSpec, value: String = SECRET) =
    spec.copy(
      state =
        spec.state.orEmpty() +
          mapOf("token" to PrototypeScalar.Text(value), "pin" to PrototypeScalar.Text(SECRET)),
    )

  @Test
  fun `secure values round trip and restore before draw without plaintext entries`() = runTest {
    val original = spec()
    val opened = persistence().open(original)
    opened.session!!.record(changed(original))
    opened.session.flush()
    assertNull(plain.value)
    assertEquals(
      mapOf("state:token" to JsonPrimitive(SECRET)),
      secure.values.getValue(original.id).values,
    )
    val restored = persistence().open(original)
    assertEquals(PrototypeScalar.Text(SECRET), restored.spec.state!!["token"])
    assertEquals(PrototypeScalar.Text(""), restored.spec.state!!["pin"])
    assertEquals(PrototypeScalar.Text(""), persistence().open(spec("other")).spec.state!!["token"])
    val report = restored.session!!.report()
    assertEquals(0, report.totalBytes)
    assertTrue(report.keys.isEmpty())
    assertEquals(
      listOf(
        PrototypeStorageSecureMetadata("state:token", true, SECRET.length),
        PrototypeStorageSecureMetadata("state:pin", false, 0),
      ),
      report.secure,
    )
    assertFalse(Json.encodeToString(report).contains(SECRET))
  }

  @Test
  fun `clear cancels pending writes and removes both stores`() = runTest {
    val original = spec()
    val session = persistence().open(original).session!!
    session.record(
      changed(original)
        .copy(state = changed(original).state!! + ("count" to PrototypeScalar.Numeric(1.0))),
    )
    session.flush()
    assertEquals(1, secure.values.size)
    assertNotNull(plain.value)
    session.record(changed(original, "pending"))
    assertEquals(2, session.clear())
    session.flush()
    assertNull(plain.value)
    assertTrue(secure.values.isEmpty())
    assertTrue(session.report().secure!!.none { it.present })
    session.record(changed(original, "pending"))
    session.flush()
    assertTrue(secure.values.isEmpty())
  }

  @Test
  fun `failed clear rewrites secure values after deletion removes them`() = runTest {
    val original = spec()
    val session = persistence().open(original).session!!
    session.record(changed(original))
    session.flush()
    secure.failDeleteAfterRemoving = true
    try {
      session.clear()
      fail("Expected secure deletion to fail")
    } catch (_: IOException) {}
    assertTrue(secure.values.isEmpty())
    assertTrue(session.report().secure!!.all { !it.present && it.bytes == 0 })
    session.flush()
    assertEquals(JsonPrimitive(SECRET), secure.values.getValue(original.id).values["state:token"])
    assertEquals(
      PrototypeStorageSecureMetadata("state:token", true, SECRET.length),
      session.report().secure!!.first(),
    )
  }

  @Test
  fun `resume rewrites secure values after quiesced deletion removes them`() = runTest {
    val original = spec()
    val session = persistence().open(original).session!!
    session.record(changed(original))
    session.flush()
    assertEquals(JsonPrimitive(SECRET), secure.values.getValue(original.id).values["state:token"])
    session.quiesce()
    secure.delete(original.id)
    assertTrue(secure.values.isEmpty())
    session.resume()
    session.flush()
    assertEquals(JsonPrimitive(SECRET), secure.values.getValue(original.id).values["state:token"])
  }

  @Test
  fun `dismiss flushes secure changes and retains them for the next show`() = runTest {
    val opened = persistence().open(spec())
    var sequence = 0L
    val runtime =
      PrototypeRuntime(
        opened.spec,
        nextSequence = { ++sequence },
        storage = opened.session,
        requestScope = backgroundScope,
      )
    runtime.handle(PrototypeInteraction.TextChange("token", SECRET))
    runtime.dismiss()
    assertEquals(JsonPrimitive(SECRET), secure.values.getValue("vault").values["state:token"])
    assertEquals(PrototypeScalar.Text(SECRET), persistence().open(spec()).spec.state!!["token"])
    runtime.close()
  }

  @Test
  fun `version changes and removed secure keys delete persisted values`() = runTest {
    val original = spec()
    val session = persistence().open(original).session!!
    session.record(changed(original))
    session.flush()
    val reopened = persistence().open(spec(version = 2))
    assertEquals(PrototypeScalar.Text(""), reopened.spec.state!!["token"])
    assertTrue(secure.values.isEmpty())
    reopened.session!!.record(changed(reopened.spec))
    reopened.session.flush()
    persistence().open(reopened.spec.copy(storage = null))
    assertTrue(secure.values.isEmpty())
  }

  @Test
  fun `utf8 limit is independent of the plaintext budget and oversized values stay live`() =
    runTest {
      val original = spec()
      val session = persistence().open(original).session!!
      session.record(changed(original, "é".repeat(2048)))
      session.flush()
      assertEquals(4096, session.report().secure!!.first().bytes)
      session.record(changed(original, "é".repeat(2049)))
      session.flush()
      assertEquals(4096, session.report().secure!!.first().bytes)
      assertEquals(listOf("state:token"), session.report().skippedKeys)
      assertEquals(0, session.report().totalBytes)
    }

  @Test
  fun `failed secure writes retry on reshow and logs omit provider payloads`() = runTest {
    val original = spec()
    val session = persistence().open(original).session!!
    session.record(changed(original))
    secure.fail = true
    session.flush()
    assertTrue(warnings.isNotEmpty())
    assertFalse(warnings.joinToString().contains(SECRET))
    secure.fail = false
    val reopened = persistence().prepare(original, session.unsavedValues())
    assertEquals(PrototypeScalar.Text(SECRET), reopened.spec.state!!["token"])
    reopened.commit()
    reopened.session!!.flush()
    assertEquals(JsonPrimitive(SECRET), secure.values.getValue(original.id).values["state:token"])
  }

  @Test
  fun `invalidated sessions cannot recreate secure storage`() = runTest {
    val original = spec()
    val session = persistence().open(original).session!!
    session.record(changed(original))
    session.invalidate()
    session.flush()
    assertTrue(secure.values.isEmpty())
  }

  @Test
  fun `quiesced and deleted preparations cannot recreate retained secure values`() = runTest {
    for (invalidate in listOf(false, true)) {
      secure.values["vault"] =
        PrototypeStoredValues(
          1,
          mapOf("state:token" to JsonPrimitive(SECRET), "state:obsolete" to JsonPrimitive("old")),
        )
      val registry = PrototypeStorageSessionRegistry()
      val opened = persistence(registry = registry).prepare(spec())
      val held = registry.quiesce("vault")
      assertEquals(2, secure.delete("vault"))
      if (invalidate) held.invalidate()
      opened.commit()
      assertTrue(secure.values.isEmpty())
    }
  }

  @Test
  fun `accepted preparation prunes obsolete secure keys and retains the current token`() = runTest {
    secure.values["vault"] =
      PrototypeStoredValues(
        1,
        mapOf("state:token" to JsonPrimitive(SECRET), "state:obsolete" to JsonPrimitive("old")),
      )
    val opened = persistence().prepare(spec())
    assertEquals(2, secure.values.getValue("vault").values.size)
    opened.commit()
    assertEquals(
      mapOf("state:token" to JsonPrimitive(SECRET)),
      secure.values.getValue("vault").values,
    )
  }

  @Test
  fun `cancel after secure io invalidates the baseline so restoring the old value writes it`() =
    runTest {
      val original = spec()
      secure.values["vault"] = PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive("A")))
      val session = persistence(StandardTestDispatcher(testScheduler)).open(original).session!!
      session.record(changed(original, "B"))
      lateinit var write: Job
      secure.afterSave = { write.cancel() }
      write = launch { session.flush() }
      runCurrent()
      assertTrue(write.isCancelled)
      assertEquals(JsonPrimitive("B"), secure.values.getValue("vault").values["state:token"])
      assertFalse(session.report().secure!!.first().present)
      secure.afterSave = {}
      session.record(changed(original, "A"))
      session.flush()
      assertEquals(JsonPrimitive("A"), secure.values.getValue("vault").values["state:token"])
    }

  @Test
  fun `clear counts the secure record written before its baseline update`() = runTest {
    val original = spec()
    val session = persistence().open(original).session!!
    lateinit var clearing: Deferred<Int>
    secure.afterSave = { clearing = async(start = CoroutineStart.UNDISPATCHED) { session.clear() } }
    session.record(changed(original))
    session.flush()
    assertEquals(1, clearing.await())
    assertTrue(secure.values.isEmpty())
    assertTrue(session.report().secure!!.none { it.present })
  }

  @Test
  fun `clear reports zero for pending secure values that never reached disk`() = runTest {
    val original = spec()
    val session = persistence().open(original).session!!
    session.record(changed(original))
    assertEquals(0, session.clear())
    session.flush()
    assertTrue(secure.values.isEmpty())
  }

  @Test
  fun `cancelled secure io cannot dirty a session after clear advances its generation`() = runTest {
    val original = spec()
    val session = persistence(StandardTestDispatcher(testScheduler)).open(original).session!!
    lateinit var clearing: Deferred<Int>
    lateinit var write: Job
    secure.afterSave = {
      clearing = async(start = CoroutineStart.UNDISPATCHED) { session.clear() }
      write.cancel()
    }
    session.record(changed(original))
    write = launch { session.flush() }
    runCurrent()
    assertEquals(1, clearing.await())
    assertNull(session.unsavedValues())
    session.flush()
    assertTrue(secure.values.isEmpty())
    assertTrue(session.report().secure!!.none { it.present })
  }

  @Test
  fun `switching a secure key to biometric drops its persisted value and keeps authored live state`() =
    runTest {
      val original = spec()
      val session = persistence().open(original).session!!
      session.record(changed(original))
      session.flush()
      val authenticated =
        original.copy(
          storage =
            original.storage!!.copy(
              secureAuth = mapOf("state:token" to "biometric", "state:pin" to "biometric"),
            ),
        )
      val reopened = persistence().open(authenticated)
      assertEquals(PrototypeScalar.Text(""), reopened.spec.state!!["token"])
      assertTrue(secure.values.isEmpty())
      reopened.session!!.record(changed(authenticated))
      reopened.session.flush()
      assertTrue(secure.values.isEmpty())
    }

  @Test
  fun `secure storage module exposes only locked metadata and refuses calls`() = runTest {
    val module = PrototypeSecureStorageModule(secure)
    assertEquals(buildJsonObject { put("locked", false) }, module.state.value)
    val result =
      module.call(PlatformCall("id", "secureStorage.read", JsonObject(emptyMap())))
        as PlatformCallResult.Failure
    assertEquals(PlatformErrorCode.UNSUPPORTED, result.error.code)
    module.close()
  }
}

internal class MemorySecureStore : PrototypeSecureValueStore {
  val values = mutableMapOf<String, PrototypeStoredValues>()
  var fail = false
  var failDeleteAfterRemoving = false
  var afterSave: () -> Unit = {}

  override fun load(id: String) = values[id]

  override fun save(id: String, stored: PrototypeStoredValues) {
    if (fail) throw IOException("private-token-14321")
    values[id] = stored
    afterSave()
  }

  override fun delete(id: String): Int {
    val removed = values.remove(id)?.values?.size ?: 0
    if (failDeleteAfterRemoving) throw IOException("Secure deletion failed after removal")
    return removed
  }
}

private class MemoryPlainStore : PrototypeStorageStore {
  var value: PrototypeStoredValues? = null

  override fun load(id: String) =
    value?.let { PrototypeStorageLoad.Loaded(it) } ?: PrototypeStorageLoad.Missing

  override fun save(id: String, stored: PrototypeStoredValues) {
    value = stored
  }

  override fun delete(id: String): Boolean = (value != null).also { value = null }
}
