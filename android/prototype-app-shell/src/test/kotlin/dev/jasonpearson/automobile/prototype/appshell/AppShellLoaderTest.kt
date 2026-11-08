package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import dev.jasonpearson.automobile.prototype.PrototypeStorage
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.BeforeClass
import org.junit.Test

class AppShellLoaderTest {
  @Test
  fun `missing spec has a typed missing state`() {
    assertEquals(AppShellState.MissingSpec, loader(null).load())
  }

  @Test
  fun `malformed JSON has a typed corrupt state`() {
    assertEquals(AppShellState.CorruptSpec, loader("{").load())
  }

  @Test
  fun `structurally invalid spec has a typed corrupt state`() {
    assertEquals(AppShellState.CorruptSpec, loader("{}").load())
  }

  @Test
  fun `valid fixture becomes ready without rewriting the payload`() {
    assertEquals(AppShellState.Ready(validSpec), loader(validSpec).load())
  }

  @Test
  fun `root back backgrounds the task`() {
    assertEquals(AppShellBackAction.MOVE_TASK_TO_BACK, appShellBackAction(1))
  }

  @Test
  fun `nested back pops the renderer stack`() {
    assertEquals(AppShellBackAction.POP, appShellBackAction(2))
    assertEquals(AppShellBackAction.POP, appShellBackAction(3))
  }

  @Test
  fun `storage restore remains renderer owned and passes the store through unchanged`() {
    val stored = PrototypeStoredValues(1, mapOf("state:count" to JsonPrimitive(7)))
    val storage = FakePrototypeStorage(stored)
    val loader = AppShellLoader(FakeAppSpecSource(validSpec), storage)
    assertEquals(AppShellState.Ready(validSpec), loader.load())
    assertSame(storage, loader.storage)
    assertEquals(0, storage.loads)
    assertSame(stored, loader.storage.load("emit-context"))
    assertEquals(1, storage.loads)
  }

  private fun loader(spec: String?) = AppShellLoader(FakeAppSpecSource(spec), PrototypeStorage.None)

  companion object {
    private lateinit var validSpec: String

    @BeforeClass
    @JvmStatic
    fun prepareFixture() {
      // Shared valid/emit-context-empty.json fixture; warm contract initialization off test time.
      validSpec =
        checkNotNull(AppShellLoaderTest::class.java.getResource("/valid-spec.json")).readText()
      check(
        AppShellLoader(FakeAppSpecSource(validSpec), PrototypeStorage.None).load()
          is AppShellState.Ready,
      )
    }
  }
}

private class FakeAppSpecSource(private val spec: String?) : AppSpecSource {
  override fun readSpec(): String? = spec
}

private class FakePrototypeStorage(private val stored: PrototypeStoredValues) : PrototypeStorage {
  var loads = 0
    private set

  override fun load(id: String): PrototypeStoredValues {
    loads++
    return stored
  }

  override fun save(id: String, values: PrototypeStoredValues) {
    error("The shell must not save storage")
  }

  override fun delete(id: String) {
    error("The shell must not delete storage")
  }
}
