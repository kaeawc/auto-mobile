package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStatusEntry
import dev.jasonpearson.automobile.protocol.PrototypeStorageKeyBytes
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * `storage` through the controller (#12522): restore on show, write-back, the inspect report,
 * `clear_prototype_storage` and a same-id re-show.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeStorageControllerTest {
  private val store = FakePrototypeStorageStore()
  private val storageTimer = FakePrototypeTimer()
  private val host = FakePrototypeHost()
  private val results = mutableListOf<Triple<String?, Boolean, String?>>()
  private val cleared = mutableListOf<Pair<String?, Int>>()
  private val statuses = mutableListOf<List<PrototypeStatusEntry>>()
  private val sink =
    object : PrototypeResultSink {
      override suspend fun send(requestId: String?, success: Boolean, error: String?) {
        results += Triple(requestId, success, error)
      }

      override suspend fun sendCleared(requestId: String?, cleared: Int) {
        this@PrototypeStorageControllerTest.cleared += requestId to cleared
      }

      override suspend fun sendPrototypeStatus(
        requestId: String?,
        prototypes: List<PrototypeStatusEntry>,
        droppedEvents: Long,
      ) {
        statuses += prototypes
      }
    }
  private val controller =
    PrototypeController(
      host,
      sink,
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      storage =
        PrototypeStoragePersistence(
          store,
          storageTimer,
          EmptyCoroutineContext,
          warn = PrototypeStorageWarn { _, _ -> },
        ),
    )

  private fun spec(
    storage: String? = """{"version":1,"keys":["state:dark","data:/cart"]}""",
  ): PrototypeSpec {
    val storageField = storage?.let { ""","storage":$it""" }.orEmpty()
    val input =
      """{"id":"prefs","window":{"placement":{"type":"fullscreen"}},"state":{"dark":false},""" +
        """"data":{"cart":{"items":[]}}$storageField,"root":{"type":"column","children":[""" +
        """{"type":"button","label":"Dark","onTap":[{"type":"toggle","key":"dark"}]}]}}"""
    val validation = PrototypeSpecValidator.validate(input)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  private fun stored(vararg values: Pair<String, JsonElement>) =
    PrototypeStoredValues(1, linkedMapOf(*values))

  private suspend fun toggle(runtime: PrototypeRuntime) =
    runtime.handle(
      PrototypeInteraction.Tap(checkNotNull(runtime.renderModel().root.children[0].source?.onTap)),
    )

  @Test
  fun `a show restores the stored values and inspect reports them`() = runTest {
    store.seed("prefs", stored("state:dark" to JsonPrimitive(true)))

    controller.show("s", spec())
    controller.inspect("i")

    assertEquals(listOf(Triple<String?, Boolean, String?>("s", true, null)), results)
    val runtime = checkNotNull(controller.activeRuntime)
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["dark"])
    // The controller's first revision for the id, as for a show with nothing stored.
    assertEquals(1L, runtime.current.revision)
    val entry = statuses.single().single()
    assertEquals(PrototypeScalar.BooleanValue(true), entry.state["dark"])
    val report = checkNotNull(entry.storage)
    assertEquals(1, report.version)
    assertEquals(listOf(PrototypeStorageKeyBytes("state:dark", 14)), report.keys)
    assertEquals(14, report.totalBytes)
    assertNull(report.skippedKeys)
  }

  @Test
  fun `inspect reports an empty list when nothing is stored and none without a storage block`() =
    runTest {
      controller.show("s", spec())
      controller.inspect("i")
      assertEquals(emptyList<PrototypeStorageKeyBytes>(), statuses.last().single().storage!!.keys)

      controller.show("s2", spec(storage = null))
      controller.inspect("i2")
      assertNull(statuses.last().single().storage)
    }

  @Test
  fun `a dismissed prototype's values return on the next show`() = runTest {
    controller.show("s1", spec())
    toggle(checkNotNull(controller.activeRuntime))
    controller.dismiss("d", "prefs", null)
    assertEquals(stored("state:dark" to JsonPrimitive(true)), store.stored("prefs"))

    controller.show("s2", spec())

    assertEquals(
      PrototypeScalar.BooleanValue(true),
      checkNotNull(controller.activeRuntime).current.state["dark"],
    )
  }

  @Test
  fun `a same-id show restores the values the shown prototype had`() = runTest {
    controller.show("s1", spec())
    toggle(checkNotNull(controller.activeRuntime))

    controller.show("s2", spec())

    assertEquals(
      PrototypeScalar.BooleanValue(true),
      checkNotNull(controller.activeRuntime).current.state["dark"],
    )
    assertEquals(stored("state:dark" to JsonPrimitive(true)), store.stored("prefs"))
  }

  @Test
  fun `reset does not clear storage`() = runTest {
    store.seed("prefs", stored("state:dark" to JsonPrimitive(true)))
    controller.show("s1", spec())

    controller.show("s2", spec(), reset = true)

    assertEquals(
      PrototypeScalar.BooleanValue(true),
      checkNotNull(controller.activeRuntime).current.state["dark"],
    )
    assertEquals(stored("state:dark" to JsonPrimitive(true)), store.stored("prefs"))
  }

  @Test
  fun `clear storage wipes the shown prototype's values and replies with the count`() = runTest {
    store.seed(
      "prefs",
      stored("state:dark" to JsonPrimitive(true), "data:/cart" to JsonPrimitive("x")),
    )
    controller.show("s", spec())

    controller.clearStorage("c", "prefs")

    // `data:/cart` held a string where the spec has an object, so only one value survived restore.
    assertEquals(listOf<Pair<String?, Int>>("c" to 1), cleared)
    assertNull(store.stored("prefs"))
    val runtime = checkNotNull(controller.activeRuntime)
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["dark"])
    controller.inspect("i")
    assertEquals(emptyList<PrototypeStorageKeyBytes>(), statuses.single().single().storage!!.keys)
    // The next show starts from the spec's values.
    controller.dismiss("d", "prefs", null)
    controller.show("s2", spec())
    assertEquals(
      PrototypeScalar.BooleanValue(false),
      checkNotNull(controller.activeRuntime).current.state["dark"],
    )
  }

  @Test
  fun `clear storage for an id with nothing stored succeeds with zero`() = runTest {
    controller.clearStorage("c", "never-shown")

    assertEquals(listOf<Pair<String?, Int>>("c" to 0), cleared)
    assertTrue(results.isEmpty())
  }
}
