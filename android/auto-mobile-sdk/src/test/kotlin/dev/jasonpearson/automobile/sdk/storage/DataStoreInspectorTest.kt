package dev.jasonpearson.automobile.sdk.storage

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DataStoreInspectorTest {

  @Before
  fun setUp() {
    DataStoreInspector.reset()
  }

  @After
  fun tearDown() {
    DataStoreInspector.reset()
  }

  // AC1 — register without exposing filesystem paths.
  @Test
  fun `registered adapter names are reported`() {
    DataStoreInspector.registerAdapter("settings", FakeDataStoreAdapter())

    assertEquals(setOf("settings"), DataStoreInspector.registeredAdapterNames())
  }

  @Test
  fun `register rejects blank name`() {
    try {
      DataStoreInspector.registerAdapter("  ", FakeDataStoreAdapter())
      throw AssertionError("Expected IllegalArgumentException")
    } catch (e: IllegalArgumentException) {
      assertTrue(e.message!!.contains("blank"))
    }
  }

  @Test
  fun `descriptor exposes no filesystem path`() = runTest {
    val adapter = FakeDataStoreAdapter().apply { setStore("settings", mapOf("a" to 1)) }
    DataStoreInspector.registerAdapter("prefs", adapter)

    val names = DataStoreInspector.storeNames("prefs")

    assertEquals(listOf("settings"), names)
    // DataStoreDescriptor deliberately has no `path` member; entries carry no path either.
    val entries = DataStoreInspector.readStore("prefs", "settings")
    assertEquals(1, entries.size)
  }

  // AC2 — stores are discoverable with entry counts and no path.
  @Test
  fun `describeStores reports names and entry counts`() = runTest {
    val adapter =
      FakeDataStoreAdapter().apply {
        setStore("settings", mapOf("a" to 1, "b" to 2))
        setStore("flags", mapOf("x" to true))
      }
    DataStoreInspector.registerAdapter("prefs", adapter)

    val byName = DataStoreInspector.describeStores("prefs").associateBy { it.name }

    assertEquals(2, byName.getValue("settings").entryCount)
    assertEquals(1, byName.getValue("flags").entryCount)
  }

  // AC2 — a store that vanishes between listing and read is omitted, not fatal to the listing.
  @Test
  fun `describeStores omits a store that disappears mid-listing`() = runTest {
    val adapter =
      object : DataStoreAdapter {
        override suspend fun storeNames() = listOf("present", "vanished")

        override suspend fun read(storeName: String): List<DataStoreEntry> =
          if (storeName == "present") listOf(DataStoreEntry("k", "v", DataStoreValueType.STRING))
          else throw DataStoreAdapterError.StoreNotFound(storeName)
      }
    DataStoreInspector.registerAdapter("prefs", adapter)

    val described = DataStoreInspector.describeStores("prefs")

    assertEquals(listOf("present"), described.map { it.name })
    assertEquals(1, described.single().entryCount)
  }

  // AC2/AC3 — structured reads of stores, keys, values, and value types.
  @Test
  fun `reads structured entries covering all supported value types`() = runTest {
    val adapter =
      FakeDataStoreAdapter().apply {
        setStore(
          "typed",
          linkedMapOf(
            "s" to "text",
            "i" to 7,
            "l" to 7L,
            "f" to 1.5f,
            "d" to 2.5,
            "b" to true,
            "set" to setOf("x", "y"),
            "bytes" to byteArrayOf(1, 2, 3),
          ),
        )
      }
    DataStoreInspector.registerAdapter("prefs", adapter)

    val byKey = DataStoreInspector.readStore("prefs", "typed").associateBy { it.key }

    assertEquals(DataStoreValueType.STRING, byKey.getValue("s").type)
    assertEquals(DataStoreValueType.INT, byKey.getValue("i").type)
    assertEquals(DataStoreValueType.LONG, byKey.getValue("l").type)
    assertEquals(DataStoreValueType.FLOAT, byKey.getValue("f").type)
    assertEquals(DataStoreValueType.DOUBLE, byKey.getValue("d").type)
    assertEquals(DataStoreValueType.BOOLEAN, byKey.getValue("b").type)
    assertEquals(DataStoreValueType.STRING_SET, byKey.getValue("set").type)
    assertEquals(DataStoreValueType.BYTE_ARRAY, byKey.getValue("bytes").type)
  }

  // AC3 — unsupported value types have a structured representation.
  @Test
  fun `unsupported value maps to UNKNOWN type`() = runTest {
    val adapter = FakeDataStoreAdapter().apply { setStore("mixed", mapOf("weird" to Any())) }
    DataStoreInspector.registerAdapter("prefs", adapter)

    val entry = DataStoreInspector.readStore("prefs", "mixed").single()

    assertEquals(DataStoreValueType.UNKNOWN, entry.type)
  }

  // AC3 — unsupported value types have a structured error when the adapter rejects them.
  @Test
  fun `adapter that rejects unsupported value surfaces UnsupportedValue`() = runTest {
    val adapter =
      FakeDataStoreAdapter().apply {
        rejectUnsupported = true
        setStore("mixed", mapOf("weird" to Any()))
      }
    DataStoreInspector.registerAdapter("prefs", adapter)

    try {
      DataStoreInspector.readStore("prefs", "mixed")
      throw AssertionError("Expected UnsupportedValue")
    } catch (e: DataStoreAdapterError.UnsupportedValue) {
      assertTrue(e.message!!.contains("mixed/weird"))
    }
  }

  // AC3 — missing adapter and missing store are structured errors.
  @Test
  fun `unknown adapter throws AdapterNotFound`() = runTest {
    try {
      DataStoreInspector.storeNames("missing")
      throw AssertionError("Expected AdapterNotFound")
    } catch (e: DataStoreAdapterError.AdapterNotFound) {
      assertTrue(e.message!!.contains("missing"))
    }
  }

  @Test
  fun `missing store throws StoreNotFound`() = runTest {
    DataStoreInspector.registerAdapter("prefs", FakeDataStoreAdapter())

    try {
      DataStoreInspector.readStore("prefs", "nope")
      throw AssertionError("Expected StoreNotFound")
    } catch (e: DataStoreAdapterError.StoreNotFound) {
      assertTrue(e.message!!.contains("nope"))
    }
  }

  // AC3 — a host exception during read is wrapped as a structured ReadError.
  @Test
  fun `host read failure is wrapped as ReadError`() = runTest {
    val adapter =
      object : DataStoreAdapter {
        override suspend fun storeNames() = listOf("s")

        override suspend fun read(storeName: String): List<DataStoreEntry> =
          throw IllegalStateException("boom")
      }
    DataStoreInspector.registerAdapter("prefs", adapter)

    try {
      DataStoreInspector.readStore("prefs", "s")
      throw AssertionError("Expected ReadError")
    } catch (e: DataStoreAdapterError.ReadError) {
      assertTrue(e.message!!.contains("boom"))
      assertTrue(e.cause is IllegalStateException)
    }
  }

  // AC4 — redaction is enforced at the boundary, not by the host.
  @Test
  fun `redaction policy redacts matching values`() = runTest {
    val adapter =
      FakeDataStoreAdapter().apply {
        setStore("auth", linkedMapOf("token" to "secret", "user" to "alice"))
      }
    DataStoreInspector.registerAdapter("prefs", adapter)
    DataStoreInspector.setRedactionPolicy { _, key -> key == "token" }

    val byKey = DataStoreInspector.readStore("prefs", "auth").associateBy { it.key }

    assertEquals(DataStoreInspector.REDACTED_VALUE, byKey.getValue("token").value)
    assertEquals("alice", byKey.getValue("user").value)
  }

  // AC4 — read-only mode: the boundary reports mutation unsupported.
  @Test
  fun `capabilities report read-only and supported types`() {
    assertFalse(DataStoreInspector.capabilities().readSupported)

    DataStoreInspector.registerAdapter("prefs", FakeDataStoreAdapter())
    val caps = DataStoreInspector.capabilities()

    assertTrue(caps.readSupported)
    assertFalse(caps.mutationSupported)
    assertFalse(caps.redactionEnabled)
    assertTrue(caps.supportedValueTypes.contains(DataStoreValueType.DOUBLE))
    assertTrue(caps.supportedValueTypes.contains(DataStoreValueType.BYTE_ARRAY))
    assertFalse(caps.supportedValueTypes.contains(DataStoreValueType.UNKNOWN))

    DataStoreInspector.setRedactionPolicy { _, _ -> true }
    assertTrue(DataStoreInspector.capabilities().redactionEnabled)
  }

  // AC5 — replacement is lifecycle-safe (last registration wins).
  @Test
  fun `registering same name replaces adapter`() = runTest {
    val first = FakeDataStoreAdapter().apply { setStore("s", mapOf("k" to "one")) }
    val second = FakeDataStoreAdapter().apply { setStore("s", mapOf("k" to "two")) }
    DataStoreInspector.registerAdapter("prefs", first)
    DataStoreInspector.registerAdapter("prefs", second)

    assertEquals(setOf("prefs"), DataStoreInspector.registeredAdapterNames())
    assertEquals("two", DataStoreInspector.readStore("prefs", "s").single().value)
  }

  // AC5 — removal is lifecycle-safe and idempotent.
  @Test
  fun `unregister returns true then false`() {
    DataStoreInspector.registerAdapter("prefs", FakeDataStoreAdapter())

    assertTrue(DataStoreInspector.unregisterAdapter("prefs"))
    assertFalse(DataStoreInspector.unregisterAdapter("prefs"))
    assertTrue(DataStoreInspector.registeredAdapterNames().isEmpty())
  }

  // AC5/AC7 — shutdown clears adapters and policy (no leaked references).
  @Test
  fun `reset clears adapters and redaction policy`() = runTest {
    val adapter = FakeDataStoreAdapter().apply { setStore("s", mapOf("token" to "secret")) }
    DataStoreInspector.registerAdapter("prefs", adapter)
    DataStoreInspector.setRedactionPolicy { _, _ -> true }

    DataStoreInspector.reset()

    assertTrue(DataStoreInspector.registeredAdapterNames().isEmpty())
    assertFalse(DataStoreInspector.capabilities().redactionEnabled)
    try {
      DataStoreInspector.storeNames("prefs")
      throw AssertionError("Expected AdapterNotFound after reset")
    } catch (_: DataStoreAdapterError.AdapterNotFound) {
      // expected
    }
  }

  // AC7 — cancellation propagates cooperatively through a suspended read.
  @Test
  fun `read honors coroutine cancellation`() = runTest {
    val gate = CompletableDeferred<Unit>()
    val adapter =
      FakeDataStoreAdapter().apply {
        setStore("s", mapOf("k" to "v"))
        readGate = gate
      }
    DataStoreInspector.registerAdapter("prefs", adapter)

    var completed = false
    val job = launch { DataStoreInspector.readStore("prefs", "s").also { completed = true } }
    // Let the coroutine reach the suspended read gate.
    yield()
    job.cancel()
    job.join()

    assertTrue(job.isCancelled)
    assertFalse("read must not complete once cancelled", completed)
    assertFalse(gate.isCompleted)
  }
}
