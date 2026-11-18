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
import kotlinx.coroutines.test.TestScope
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
  fun `push refuses secure route params before events or plaintext persistence`() = runTest {
    assertRouteBindingRefused { PrototypePushAction("nav", "detail", params = it) }
  }

  @Test
  fun `replace refuses secure route params before events or plaintext persistence`() = runTest {
    assertRouteBindingRefused { PrototypeReplaceAction("nav", "detail", params = it) }
  }

  @Test
  fun `setStack refuses the whole path when a later entry binds secure state`() = runTest {
    assertRouteBindingRefused {
      PrototypeSetStackAction(
        "nav",
        listOf(PrototypeRouteEntry("home"), PrototypeRouteEntry("detail", it)),
      )
    }
  }

  private fun routeSpec(): PrototypeSpec {
    val base = spec()
    return base.copy(
      state = base.state!! + ("public" to PrototypeScalar.Text("hello")),
      storage = base.storage!!.copy(keys = listOf("stack:nav", "state:public")),
      root =
        PrototypeStackNode(
          "nav",
          start = "home",
          screens =
            mapOf(
              "home" to PrototypeTextNode(text = "Home"),
              "detail" to PrototypeTextNode(text = "Detail"),
            ),
          routes = mapOf("detail" to PrototypeRoute(params = mapOf("t" to "string"))),
        ),
    )
  }

  private suspend fun TestScope.assertRouteBindingRefused(
    action: (Map<String, JsonElement>) -> PrototypeAction,
  ) {
    val opened = persistence().open(routeSpec())
    val session = checkNotNull(opened.session)
    val events = mutableListOf<PrototypeEvent>()
    var sequence = 0L
    val runtime =
      PrototypeRuntime(
        changed(opened.spec),
        PrototypeEventSink { events += it },
        { 42L },
        { ++sequence },
        warn = { warnings += it },
        storage = session,
        requestScope = backgroundScope,
      )
    val before = runtime.current.stacks
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(action(mapOf("t" to buildJsonObject { put("state", "token") }))),
      ),
    )
    assertEquals(before, runtime.current.stacks)
    assertTrue(events.isEmpty())
    // A state change on a listed key dirties storage, so the flush writes the stored stack too.
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(PrototypeSetStateAction("public", PrototypeScalar.Text("x"))),
      ),
    )
    session.flush()
    val stored = checkNotNull(plain.value).values
    // An unchanged stack is never rewritten; if it is stored it must be the original one.
    stored["stack:nav"]?.let {
      assertEquals(PrototypeRouteRuntime.storedValue(before.getValue("nav")), it)
    }
    assertFalse(
      (events.joinToString { Json.encodeToString(it) } + stored + warnings).contains(SECRET),
    )
    assertTrue(warnings.isNotEmpty())
    assertAcceptsPublicBinding(runtime, session, events, action)
    runtime.close()
  }

  private suspend fun assertAcceptsPublicBinding(
    runtime: PrototypeRuntime,
    session: PrototypeStorageSession,
    events: List<PrototypeEvent>,
    action: (Map<String, JsonElement>) -> PrototypeAction,
  ) {
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(action(mapOf("t" to buildJsonObject { put("state", "public") }))),
      ),
    )
    session.flush()
    val stack = runtime.current.stacks.getValue("nav")
    assertEquals(JsonPrimitive("x"), stack.paramsAt(stack.path.lastIndex)["t"])
    assertTrue(events.any { it.kind == PrototypeEventKind.SCREEN_CHANGED })
    assertFalse(
      (events.joinToString { Json.encodeToString(it) } + plain.value + warnings).contains(SECRET),
    )
  }

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
  fun `inner reset or resume cannot release an outer quiesce hold`() = runTest {
    for (resetInner in listOf(false, true)) {
      val original = spec()
      val registry = PrototypeStorageSessionRegistry()
      val session = persistence(registry = registry).open(original).session!!
      session.record(changed(original))
      val outer = registry.quiesce(original.id)
      val inner = registry.quiesce(original.id)
      if (resetInner) inner.reset() else inner.resume()
      // Completing a hold twice must not release the other hold.
      inner.resume()
      session.record(changed(original, "later"))
      session.flush()
      assertTrue(secure.values.isEmpty())
      outer.resume()
      session.flush()
      assertEquals(
        JsonPrimitive("later"),
        secure.values.getValue(original.id).values["state:token"],
      )
      secure.delete(original.id)
    }
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
  fun `delete during secure load fences registration and both preparation writes`() = runTest {
    assertPreparationFenced { registry -> registry.quiesce("vault").invalidate() }
  }

  @Test
  fun `reset during secure load fences registration and both preparation writes`() = runTest {
    assertPreparationFenced { registry -> registry.quiesce("vault").reset() }
  }

  @Test
  fun `direct invalidation during secure load fences registration`() = runTest {
    assertPreparationFenced { registry -> registry.invalidate("vault") }
  }

  @Test
  fun `reset completing during secure load advances the preparation epoch`() = runTest {
    val registry = PrototypeStorageSessionRegistry()
    val held = registry.quiesce("vault")
    assertPreparationFenced(registry) { held.reset() }
  }

  @Test
  fun `preparation registered during cleanup cannot persist after reset completes`() = runTest {
    val registry = PrototypeStorageSessionRegistry()
    val held = registry.quiesce("vault")
    secure.values["vault"] = PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive(SECRET)))
    val opened = persistence(registry = registry).prepare(spec())
    secure.delete("vault")
    held.reset()
    // Completing a hold twice must not affect a later, independent preparation.
    held.resume()
    opened.commit()
    val session = checkNotNull(opened.session)
    session.record(changed(spec(), "later"))
    session.flush()
    assertTrue(secure.values.isEmpty())

    val fresh = checkNotNull(persistence(registry = registry).open(spec()).session)
    fresh.record(changed(spec(), "new"))
    fresh.flush()
    assertEquals(JsonPrimitive("new"), secure.values.getValue("vault").values["state:token"])
  }

  private suspend fun assertPreparationFenced(
    registry: PrototypeStorageSessionRegistry = PrototypeStorageSessionRegistry(),
    fence: (PrototypeStorageSessionRegistry) -> Unit,
  ) {
    val original = spec()
    plain.value =
      PrototypeStoredValues(
        1,
        mapOf("state:count" to JsonPrimitive(1), "state:obsolete" to JsonPrimitive("old")),
      )
    secure.values[original.id] =
      PrototypeStoredValues(
        1,
        mapOf("state:token" to JsonPrimitive(SECRET), "state:obsolete" to JsonPrimitive("old")),
      )
    secure.afterLoad = {
      fence(registry)
      secure.delete(original.id)
      plain.delete(original.id)
    }
    val opened = persistence(registry = registry).prepare(original)
    opened.commit()
    assertTrue(secure.values.isEmpty())
    assertNull(plain.value)
    val session = checkNotNull(opened.session)
    session.record(
      changed(original, "later")
        .copy(
          state =
            checkNotNull(changed(original, "later").state) +
              ("count" to PrototypeScalar.Numeric(2.0)),
        ),
    )
    session.flush()
    assertTrue(secure.values.isEmpty())
    assertNull(plain.value)
    assertNull(session.unsavedValues())
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
  var afterLoad: () -> Unit = {}

  override fun load(id: String) = values[id].also { afterLoad() }

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
