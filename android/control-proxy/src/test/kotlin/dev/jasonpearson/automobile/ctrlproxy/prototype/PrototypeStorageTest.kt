package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeRemoveDataAction
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStorageKeyBytes
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/**
 * Stored prototype values on the device (#12522): load on show, version resets, debounced
 * write-back, a corrupt document, clearing and the byte limit. A fake store and the fake timer
 * stand in for the disk and the clock.
 */
class PrototypeStorageTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }

    private const val STATE = """{"dark":false,"count":2}"""
    private const val STORAGE = """{"version":1,"keys":["state:dark","state:count","data:/cart"]}"""
  }

  private val store = FakePrototypeStorageStore()
  private val timer = FakePrototypeTimer()
  private val warnings = mutableListOf<String>()
  private val events = mutableListOf<PrototypeEvent>()
  private var sequence = 0L

  private fun persistence(io: CoroutineContext = EmptyCoroutineContext) =
    PrototypeStoragePersistence(
      store,
      timer,
      io,
      warn = PrototypeStorageWarn { message, _ -> warnings += message },
    )

  private fun spec(storage: String? = STORAGE, state: String = STATE): PrototypeSpec {
    val storageField = storage?.let { ""","storage":$it""" }.orEmpty()
    val input =
      """{"id":"prefs","window":{"placement":{"type":"fullscreen"}},"state":$state,""" +
        """"data":{"cart":{"items":[]},"title":"T"}$storageField,"root":{"type":"column","children":[""" +
        """{"type":"button","label":"Dark","onTap":[{"type":"toggle","key":"dark"}]},""" +
        """{"type":"button","label":"Add","onTap":[{"type":"appendData","path":"/data/cart/items","value":{"value":"latte"}}]},""" +
        """{"type":"button","label":"Title","onTap":[{"type":"setData","path":"/data/title","value":{"value":"U"}}]},""" +
        """{"type":"button","label":"Dismiss","onTap":[{"type":"dismiss"}]}]}}"""
    val validation = PrototypeSpecValidator.validate(input)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  private suspend fun open(
    spec: PrototypeSpec = spec(),
    persistence: PrototypeStoragePersistence = persistence(),
  ): Pair<PrototypeRuntime, PrototypeStorageOpen> {
    val opened = persistence.open(spec)
    val runtime =
      PrototypeRuntime(
        opened.spec,
        PrototypeEventSink { events += it },
        { 42L },
        { ++sequence },
        warn = { warnings += it },
        storage = opened.session,
      )
    return runtime to opened
  }

  private fun PrototypeRuntime.tap(button: Int) =
    PrototypeInteraction.Tap(checkNotNull(renderModel().root.children[button].source?.onTap))

  private fun stored(vararg values: Pair<String, JsonElement>, version: Int = 1) =
    PrototypeStoredValues(version, linkedMapOf(*values))

  private fun json(text: String) = Json.parseToJsonElement(text)

  private fun cart(runtime: PrototypeRuntime) = runtime.current.spec.data!!["cart"]!!.jsonObject

  @Test
  fun `a show loads stored values over the spec's before the first draw without an event`() =
    runTest {
      store.seed(
        "prefs",
        stored("state:dark" to JsonPrimitive(true), "data:/cart" to json("""{"items":["tea"]}""")),
      )

      val (runtime, opened) = open()

      assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["dark"])
      assertEquals(PrototypeScalar.Numeric(2.0), runtime.current.state["count"])
      assertEquals(json("""["tea"]"""), cart(runtime)["items"])
      // Restoring is not a device write.
      assertEquals(0L, runtime.current.revision)
      assertEquals(emptyList<PrototypeEvent>(), events)
      assertEquals(emptyList<String>(), warnings)
      assertEquals(
        listOf(
          PrototypeStorageKeyBytes("state:dark", 14),
          PrototypeStorageKeyBytes("data:/cart", 10 + """{"items":["tea"]}""".length),
        ),
        opened.session!!.report().keys,
      )
      assertEquals(emptyList<Any>(), store.saves)
    }

  @Test
  fun `a version change discards the stored values and deletes the document`() = runTest {
    store.seed("prefs", stored("state:dark" to JsonPrimitive(true), version = 1))

    val (runtime, opened) =
      open(spec(storage = """{"version":2,"keys":["state:dark","data:/cart"]}"""))

    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["dark"])
    assertNull(store.stored("prefs"))
    assertEquals(listOf("prefs"), store.deletes)
    assertEquals(emptyList<PrototypeStorageKeyBytes>(), opened.session!!.report().keys)
    assertEquals(2, opened.session.report().version)
  }

  @Test
  fun `a show without storage deletes whatever was stored`() = runTest {
    store.seed("prefs", stored("state:dark" to JsonPrimitive(true)))

    val (runtime, opened) = open(spec(storage = null))

    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["dark"])
    assertNull(opened.session)
    assertNull(store.stored("prefs"))
  }

  @Test
  fun `a stored value that no longer fits is dropped and the rest are kept`() = runTest {
    store.seed(
      "prefs",
      stored("state:dark" to JsonPrimitive("yes"), "state:count" to JsonPrimitive(9)),
    )

    val (runtime, _) = open()

    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["dark"])
    assertEquals(PrototypeScalar.Numeric(9.0), runtime.current.state["count"])
    assertEquals(stored("state:count" to JsonPrimitive(9)), store.stored("prefs"))
  }

  @Test
  fun `a corrupt document falls back to the spec's values, warns and is deleted`() = runTest {
    store.documents["prefs"] = PrototypeStorageLoad.Corrupt("Stored document is not JSON")

    val (runtime, _) = open()

    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["dark"])
    assertEquals(1, warnings.size)
    assertTrue(warnings.single(), warnings.single().contains("Stored document is not JSON"))
    assertNull(store.documents["prefs"])
  }

  @Test
  fun `a restored spec the device rejects falls back to the spec's values`() = runTest {
    store.seed("prefs", stored("state:count" to JsonPrimitive(9)))

    val opened = persistence().open(spec()) { false }

    assertEquals(PrototypeScalar.Numeric(2.0), opened.spec.state!!["count"])
    assertNull(store.stored("prefs"))
    assertEquals(1, warnings.size)
  }

  @Test
  fun `a data action writes back once the debounce window has passed`() = runTest {
    val (runtime, opened) = open()

    runtime.handle(runtime.tap(1))
    timer.advance(PROTOTYPE_STORAGE_DEBOUNCE_MILLIS - 1)
    assertEquals(emptyList<Any>(), store.saves)

    timer.advance(1)
    val (id, saved) = store.saves.single()
    assertEquals("prefs", id)
    assertEquals(
      stored("data:/cart" to json("""{"items":["latte"]}""")),
      saved,
    )
    // Only the key that changed is stored; the others keep the spec's values.
    assertEquals(listOf("data:/cart"), opened.session!!.report().keys.map { it.key })
  }

  @Test
  fun `changes inside one window share a single write`() = runTest {
    val (runtime, _) = open()

    runtime.handle(runtime.tap(0))
    timer.advance(200)
    runtime.handle(runtime.tap(1))
    timer.advance(200)
    runtime.handle(runtime.tap(2)) // /data/title is not listed
    timer.advance(PROTOTYPE_STORAGE_DEBOUNCE_MILLIS)

    val saved = store.saves.single().second
    assertEquals(
      listOf("state:dark", "data:/cart"),
      saved.values.keys.toList(),
    )
    assertEquals(JsonPrimitive(true), saved.values["state:dark"])
  }

  @Test
  fun `an unlisted write stores nothing`() = runTest {
    val (runtime, _) = open()

    runtime.handle(runtime.tap(2))
    timer.advance(10 * PROTOTYPE_STORAGE_DEBOUNCE_MILLIS)

    assertEquals(emptyList<Any>(), store.saves)
  }

  @Test
  fun `dismissal flushes without waiting for the debounce`() = runTest {
    val (runtime, _) = open()

    runtime.handle(runtime.tap(0))
    assertEquals(emptyList<Any>(), store.saves)
    runtime.handle(runtime.tap(3))

    assertEquals(stored("state:dark" to JsonPrimitive(true)), store.saves.single().second)
    // The pending timer has nothing left to write.
    timer.advance(PROTOTYPE_STORAGE_DEBOUNCE_MILLIS)
    assertEquals(1, store.saves.size)
  }

  @Test
  fun `a host patch against a stored key wins and is then stored`() = runTest {
    store.seed("prefs", stored("state:dark" to JsonPrimitive(true)))
    val (runtime, _) = open()
    val validate = { patched: kotlinx.serialization.json.JsonObject ->
      val result = PrototypeSpecValidator.validate(patched.toString())
      (result as PrototypeSpecValidation.Success).spec
    }

    val result =
      runtime.patch(
        0L,
        json("""[{"op":"replace","path":"/state/dark","value":false}]""").jsonArray,
        Json { classDiscriminator = "type" },
        validate,
      )

    assertTrue(result.toString(), result is PrototypeRuntime.PatchResult.Applied)
    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["dark"])
    timer.advance(PROTOTYPE_STORAGE_DEBOUNCE_MILLIS)
    assertEquals(stored("state:dark" to JsonPrimitive(false)), store.saves.single().second)
  }

  @Test
  fun `a failing disk is logged and retried on the next flush`() = runTest {
    val (runtime, _) = open()
    store.refuseWrites = true

    runtime.handle(runtime.tap(0))
    timer.advance(PROTOTYPE_STORAGE_DEBOUNCE_MILLIS)
    assertEquals(1, warnings.size)
    assertTrue(warnings.single(), warnings.single().contains("disk full"))

    store.refuseWrites = false
    runtime.flushStorage()
    assertEquals(stored("state:dark" to JsonPrimitive(true)), store.saves.single().second)
  }

  @Test
  fun `clearing removes the stored values and the pending write`() = runTest {
    store.seed(
      "prefs",
      stored("state:dark" to JsonPrimitive(true), "state:count" to JsonPrimitive(5)),
    )
    val (runtime, opened) = open()
    runtime.handle(runtime.tap(1))

    assertEquals(3, opened.session!!.clear())

    assertNull(store.stored("prefs"))
    timer.advance(PROTOTYPE_STORAGE_DEBOUNCE_MILLIS)
    assertEquals(emptyList<Any>(), store.saves)
    assertEquals(emptyList<PrototypeStorageKeyBytes>(), opened.session.report().keys)
    // The prototype on screen keeps its live values.
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["dark"])
    // Later writes store only what changed since.
    runtime.handle(runtime.tap(0))
    runtime.flushStorage()
    assertEquals(stored("state:dark" to JsonPrimitive(false)), store.saves.single().second)
  }

  @Test
  fun `clearing an id nobody shows counts the keys on disk`() = runTest {
    store.seed(
      "prefs",
      stored("state:dark" to JsonPrimitive(true), "state:count" to JsonPrimitive(5)),
    )

    assertEquals(2, persistence().clear("prefs"))
    assertEquals(0, persistence().clear("prefs"))
    assertNull(store.stored("prefs"))
  }

  @Test
  fun `an over-limit write applies live but is skipped and listed`() = runTest {
    val big = "x".repeat(200_000)
    val (runtime, opened) =
      open(
        spec(
          storage = """{"version":1,"keys":["state:note","state:other"]}""",
          state = """{"dark":false,"count":2,"note":"","other":""}""",
        ),
      )
    val session = opened.session!!
    suspend fun write(key: String, value: String) {
      val before = runtime.current.spec
      // A state write the way a text field makes one.
      runtime.handle(PrototypeInteraction.TextChange(key, value))
      assertEquals(PrototypeScalar.Text(value), runtime.current.state[key])
      assertTrue(before !== runtime.current.spec)
    }

    write("note", big)
    write("other", big) // 400k together: over MAX_PROTOTYPE_STORAGE_BYTES

    val report = session.report()
    assertEquals(listOf("state:note"), report.keys.map { it.key })
    assertEquals(listOf("state:other"), report.skippedKeys)
    assertTrue(report.totalBytes <= 262_144)
    timer.advance(PROTOTYPE_STORAGE_DEBOUNCE_MILLIS)
    assertEquals(listOf("state:note"), store.saves.single().second.values.keys.toList())

    // Once it fits again the skip is forgotten.
    write("other", "short")
    assertNull(session.report().skippedKeys)
    assertEquals(listOf("state:note", "state:other"), session.report().keys.map { it.key })
  }

  @Test
  fun `a removed listed pointer loses its stored value`() = runTest {
    store.seed("prefs", stored("data:/cart" to json("""{"items":["tea"]}""")))
    val (runtime, opened) = open()
    assertEquals(1, opened.session!!.report().keys.size)
    val removal = PrototypeInteraction.Tap(listOf(PrototypeRemoveDataAction("/data/cart")))

    runtime.handle(removal)
    runtime.flushStorage()

    assertNull(store.stored("prefs"))
  }

  @Test
  fun `preparing a show changes nothing on disk until it is committed`() = runTest {
    store.seed("prefs", stored("state:dark" to JsonPrimitive(true), version = 1))

    val prepared = persistence().prepare(spec(storage = null))

    assertEquals(PrototypeScalar.BooleanValue(false), prepared.spec.state!!["dark"])
    assertEquals(stored("state:dark" to JsonPrimitive(true)), store.stored("prefs"))
    assertEquals(emptyList<String>(), store.deletes)
    assertEquals(emptyList<Any>(), store.saves)

    prepared.commit()
    prepared.commit()

    assertNull(store.stored("prefs"))
    assertEquals(listOf("prefs"), store.deletes)
  }

  /** Runs io work inline until [hold], then queues it for the test to run in an order it picks. */
  private class ManualDispatcher : CoroutineDispatcher() {
    var hold = false
    val queue = ArrayDeque<Runnable>()

    override fun dispatch(context: CoroutineContext, block: Runnable) {
      if (hold) queue.addLast(block) else block.run()
    }
  }

  @Test
  fun `a clear is not overtaken by a save already in flight`() =
    runTest(UnconfinedTestDispatcher()) {
      val io = ManualDispatcher()
      val (runtime, opened) = open(persistence = persistence(io))
      runtime.handle(runtime.tap(0))
      io.hold = true
      val writer = launch { opened.session!!.flush() }
      val clearer = launch { opened.session!!.clear() }

      // The most recently queued io work runs first, as a later thread can win the race.
      io.hold = false
      while (io.queue.isNotEmpty()) io.queue.removeLast().run()
      writer.join()
      clearer.join()

      assertEquals(listOf("prefs"), store.saves.map { it.first })
      assertNull(store.stored("prefs"))
    }

  @Test
  fun `a snapshot taken before a clear is discarded and not written back`() =
    runTest(UnconfinedTestDispatcher()) {
      val io = ManualDispatcher()
      val (runtime, opened) = open(persistence = persistence(io))
      val session = opened.session!!
      runtime.handle(runtime.tap(0))
      // The first write is in flight on the io dispatcher, holding the session's disk order.
      io.hold = true
      val first = launch { session.flush() }
      runtime.handle(runtime.tap(0))
      // The second snapshots the document, then waits behind the first.
      val second = launch { session.flush() }
      val clearer = launch { session.clear() }

      io.hold = false
      while (io.queue.isNotEmpty()) io.queue.removeFirst().run()
      first.join()
      second.join()
      clearer.join()

      assertEquals(1, store.saves.size)
      assertNull(store.stored("prefs"))
    }
}
