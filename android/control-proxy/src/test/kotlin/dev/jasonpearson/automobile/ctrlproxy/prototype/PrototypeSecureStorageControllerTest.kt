package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.PrototypePlatform
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeSecureStorageControllerTest {
  private val secure = ControllerSecureStore()
  private val plain = FakePrototypeStorageStore()
  private val statuses = mutableListOf<PrototypeStatusEntry>()
  private val results = mutableListOf<Boolean>()
  private val errors = mutableListOf<String?>()
  private val sink =
    object : PrototypeResultSink {
      override suspend fun send(requestId: String?, success: Boolean, error: String?) {
        results += success
        errors += error
      }

      override suspend fun sendPrototypeStatus(
        requestId: String?,
        prototypes: List<PrototypeStatusEntry>,
        droppedEvents: Long,
      ) {
        statuses += prototypes
      }
    }

  private fun controller(registered: Boolean, plainOnly: Boolean = false) =
    PrototypeController(
      FakePrototypeHost(),
      sink,
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      storage =
        PrototypeStoragePersistence(
          PrototypeStorageBackends(plain, if (plainOnly) null else secure),
          FakePrototypeTimer(),
          EmptyCoroutineContext,
        ),
      platform =
        if (registered) PrototypePlatform(listOf(PrototypeSecureStorageModule(secure)))
        else PrototypePlatform.None,
      purgeSecureStorage = { id -> if (plainOnly) secure.delete(id) else 0 },
    )

  private fun spec() =
    (PrototypeSpecValidator.validate(
        """{"id":"vault","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["secureStorage"]},"state":{"token":"","count":0},"storage":{"version":1,"keys":["state:count"],"secure":["state:token"]},"root":{"type":"text","text":"Vault"}}""",
      ) as PrototypeSpecValidation.Success)
      .spec

  @Test
  fun `registered host status and inspect never serialize restored secret and clear removes it`() =
    runTest {
      secure.value =
        PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive("private-token-14321")))
      val controller = controller(true)
      controller.show("show", spec())
      controller.inspect("inspect")
      assertEquals(listOf(true), results)
      assertFalse(statuses.isEmpty())
      assertFalse(statuses.joinToString { Json.encodeToString(it) }.contains("private-token-14321"))
      assertFalse("token" in statuses.last().state)
      assertTrue(statuses.last().storage!!.secure!!.single().present)
      controller.clearStoredValues("vault")
      assertNull(secure.value)
      controller.dismiss("dismiss", "vault", false)
    }

  @Test
  fun `overlay refuses secure storage without registering the module`() = runTest {
    val controller = controller(false)
    controller.show("show", spec())
    assertEquals(listOf(false), results)
    assertTrue(errors.single()!!.contains("app-owned Activity host"))
    assertNull(controller.activeRuntime)
  }

  @Test
  fun `plain overlay show preserves Activity secure storage until explicit clear`() = runTest {
    secure.value = PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive("dummy-token")))
    val controller = controller(false, plainOnly = true)
    val original = spec()
    controller.show(
      "show",
      original.copy(requires = null, storage = original.storage!!.copy(secure = null)),
    )
    assertEquals(listOf(true), results)
    assertNotNull(secure.value)
    assertEquals(1, controller.clearStoredValues("vault"))
    assertNull(secure.value)
    controller.dismiss("dismiss", "vault", false)
  }

  @Test
  fun `explicit purge clears Activity secure storage without an overlay session`() = runTest {
    secure.value = PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive("dummy-token")))
    assertEquals(1, controller(false, plainOnly = true).clearStoredValues("vault"))
    assertNull(secure.value)
  }

  @Test
  fun `clear of an unshown id removes secure storage`() = runTest {
    secure.value =
      PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive("private-token-14321")))
    assertEquals(1, controller(false).clearStoredValues("vault"))
    assertNull(secure.value)
  }
}

private class ControllerSecureStore : PrototypeSecureValueStore {
  var value: PrototypeStoredValues? = null

  override fun load(id: String) = value

  override fun save(id: String, stored: PrototypeStoredValues) {
    value = stored
  }

  override fun delete(id: String): Int = (value?.values?.size ?: 0).also { value = null }
}
