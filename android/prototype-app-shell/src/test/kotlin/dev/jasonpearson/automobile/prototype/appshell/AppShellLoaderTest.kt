package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import dev.jasonpearson.automobile.prototype.PrototypeStorage
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.BeforeClass
import org.junit.Test

class AppShellLoaderTest {
  @Test
  fun `permissions fixture loads and the template advertises its registered capability`() {
    assertEquals(AppShellState.Ready(permissionsSpec), loader(permissionsSpec).load())
    val file =
      generateSequence(java.io.File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .map { java.io.File(it, "android/prototype-app-shell/src/base/assets/capabilities.json") }
        .first { it.isFile }
    val capabilities =
      kotlinx.serialization.json.Json.parseToJsonElement(file.readText())
        .jsonObject
        .getValue("capabilities")
        .jsonArray
        .map { it.jsonPrimitive.content }
    org.junit.Assert.assertTrue("prototype_platform_permissions_v1" in capabilities)
    org.junit.Assert.assertTrue("prototype_platform_secureStorage_v1" in capabilities)
    org.junit.Assert.assertFalse("prototype_platform_notifications_v1" in capabilities)
  }

  @Test
  fun `secure storage spec loads without rewriting the contract`() {
    val input =
      """{"id":"vault","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["secureStorage"]},"state":{"token":"","count":0},"storage":{"version":1,"keys":["state:count"],"secure":["state:token"]},"root":{"type":"text","text":"Vault"}}"""
    assertEquals(AppShellState.Ready(input), loader(input).load())
  }

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

  @Test
  fun `biometric fixture loads without rewriting its contract`() {
    assertEquals(AppShellState.Ready(biometricSpec), loader(biometricSpec).load())
  }

  private fun loader(spec: String?) = AppShellLoader(FakeAppSpecSource(spec), PrototypeStorage.None)

  companion object {
    private lateinit var validSpec: String
    private lateinit var biometricSpec: String
    private lateinit var permissionsSpec: String

    @BeforeClass
    @JvmStatic
    fun prepareFixture() {
      permissionsSpec =
        generateSequence(java.io.File(System.getProperty("user.dir")).absoluteFile) {
            it.parentFile
          }
          .map {
            java.io.File(it, "test/fixtures/prototype-spec/valid/platform-permissions-request.json")
          }
          .first { it.isFile }
          .readText()
      biometricSpec =
        generateSequence(java.io.File(System.getProperty("user.dir")).absoluteFile) {
            it.parentFile
          }
          .map { java.io.File(it, "test/fixtures/prototype-spec/valid/platform-biometric.json") }
          .first { it.isFile }
          .readText()
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
