package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.PrototypePlatform
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import javax.crypto.spec.SecretKeySpec
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeSecureStorageControllerTest {
  @get:Rule val temp = TemporaryFolder()
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

  private fun controller(
    registered: Boolean,
    plainOnly: Boolean = false,
    sessions: PrototypeStorageSessionRegistry = PrototypeStorageSessionRegistry(),
    plainStore: PrototypeStorageStore = plain,
    secureStore: PrototypeSecureValueStore = secure,
  ) =
    PrototypeController(
      FakePrototypeHost(),
      sink,
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      storage =
        PrototypeStoragePersistence(
          PrototypeStorageBackends(plainStore, if (plainOnly) null else secureStore),
          FakePrototypeTimer(),
          EmptyCoroutineContext,
        ),
      platform =
        if (registered) PrototypePlatform(listOf(PrototypeSecureStorageModule(secureStore)))
        else PrototypePlatform.None,
      purgeSecureStorage = { id -> if (plainOnly) secureStore.delete(id) else 0 },
      storageSessions = sessions,
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
  fun `reset waits for an Activity debounce already saving before purging its secret`() = runTest {
    val sessions = PrototypeStorageSessionRegistry()
    val timer = FakePrototypeTimer()
    val original = spec()
    val session =
      PrototypeStoragePersistence(
          PrototypeStorageBackends(plain, secure),
          timer,
          EmptyCoroutineContext,
          registry = sessions,
        )
        .open(original)
        .session!!
    val controller = controller(false, plainOnly = true, sessions = sessions)
    lateinit var reset: Deferred<Int>
    // The store API is synchronous. Start cleanup inline before the fake commits the save;
    // cleanup must suspend on the session's disk mutex until this callback returns.
    secure.beforeSave = {
      reset = async(start = CoroutineStart.UNDISPATCHED) { controller.clearStoredValues("vault") }
      assertFalse(reset.isCompleted)
      assertEquals(0, secure.deletes)
    }
    session.record(
      original.copy(state = original.state!! + ("token" to PrototypeScalar.Text("secret"))),
    )
    timer.advance(PROTOTYPE_STORAGE_DEBOUNCE_MILLIS)
    assertEquals(1, reset.await())
    assertNull(secure.value)
    session.flush()
    assertNull(secure.value)
  }

  @Test
  fun `reset drains a plaintext save before purging ciphertext and alias`() = runTest {
    val race = StorageWriteRaceFixture(temp.newFolder())
    val controller = controller(false, true, race.registry, race.plain, race.secure)
    race.blockPlainSave(this) { controller.clearStoredValues(race.original.id) }
  }

  @Test
  fun `reset fences a write paused after its generation check before IO`() = runTest {
    val race = StorageWriteRaceFixture(temp.newFolder())
    val controller = controller(false, true, race.registry, race.plain, race.secure)
    race.afterGenerationCheck(this) { controller.clearStoredValues(race.original.id) }
  }

  @Test
  fun `clear of an unshown id removes secure storage`() = runTest {
    secure.value =
      PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive("private-token-14321")))
    assertEquals(1, controller(false).clearStoredValues("vault"))
    assertNull(secure.value)
  }
}

/** Both cleanup paths exercise the real ciphertext store with only the Keystore replaced. */
@OptIn(ExperimentalCoroutinesApi::class)
internal class StorageWriteRaceFixture(private val root: File) {
  val registry = PrototypeStorageSessionRegistry()
  val plain = FakePrototypeStorageStore()
  private val aliases = mutableSetOf<String>()
  private val keys =
    object : PrototypeSecureKeyProvider {
      override fun key(alias: String, create: Boolean) =
        if (alias in aliases || create) {
          aliases += alias
          SecretKeySpec(ByteArray(32) { 7 }, "AES")
        } else null

      override fun delete(alias: String) {
        aliases.remove(alias)
      }
    }
  private val encrypted = FilePrototypeSecureValueStore(root, PrototypeSecureCipher(keys))
  private var secureSaves = 0
  val secure =
    object : PrototypeSecureValueStore by encrypted {
      override fun save(id: String, stored: PrototypeStoredValues) {
        secureSaves++
        encrypted.save(id, stored)
      }
    }
  val original =
    PrototypeSpec(
      "vault",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      requires = PrototypeRequires(platform = listOf("secureStorage")),
      state = mapOf("token" to PrototypeScalar.Text(""), "count" to PrototypeScalar.Numeric(0.0)),
      storage = PrototypeStorageBlock(1, listOf("state:count"), secure = listOf("state:token")),
      root = PrototypeTextNode(text = "Vault"),
    )

  private suspend fun open(
    store: PrototypeStorageStore,
    io: CoroutineContext,
  ): PrototypeStorageSession {
    secure.save(original.id, PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive("old"))))
    val session =
      PrototypeStoragePersistence(
          PrototypeStorageBackends(store, secure),
          FakePrototypeTimer(),
          io,
          registry = registry,
        )
        .open(original)
        .session!!
    secureSaves = 0
    session.record(
      original.copy(
        state =
          mapOf("token" to PrototypeScalar.Text("new"), "count" to PrototypeScalar.Numeric(1.0)),
      ),
    )
    return session
  }

  suspend fun blockPlainSave(scope: CoroutineScope, cleanup: suspend () -> Unit) {
    val entered = CompletableDeferred<Unit>()
    val release = CountDownLatch(1)
    val blocking =
      object : PrototypeStorageStore by plain {
        override fun save(id: String, stored: PrototypeStoredValues) {
          entered.complete(Unit)
          release.await()
          plain.save(id, stored)
        }
      }
    Executors.newSingleThreadExecutor().asCoroutineDispatcher().use { io ->
      val session = open(blocking, io)
      val writer = scope.async(start = CoroutineStart.UNDISPATCHED) { session.flush() }
      val clearing =
        try {
          entered.await()
          scope
            .async(start = CoroutineStart.UNDISPATCHED) { cleanup() }
            .also {
              assertFalse(it.isCompleted)
              assertCiphertextPresent()
            }
        } finally {
          release.countDown()
        }
      writer.await()
      clearing.await()
      assertEquals(1, plain.saves.size)
      assertEmpty(session)
    }
  }

  suspend fun afterGenerationCheck(scope: TestScope, cleanup: suspend () -> Unit) {
    val session = open(plain, StandardTestDispatcher(scope.testScheduler))
    // UNDISPATCHED enters write(), passes its outer check and owns diskLock; withContext(io)
    // queues the actual I/O until runCurrent releases it, without blocking a real thread.
    val writer = scope.async(start = CoroutineStart.UNDISPATCHED) { session.flush() }
    val clearing = scope.async(start = CoroutineStart.UNDISPATCHED) { cleanup() }
    assertFalse(writer.isCompleted)
    assertFalse(clearing.isCompleted)
    assertCiphertextPresent()
    scope.runCurrent()
    writer.await()
    clearing.await()
    assertTrue(plain.saves.isEmpty())
    assertEmpty(session)
  }

  private fun assertCiphertextPresent() {
    assertEquals(1, root.listFiles()!!.size)
    assertEquals(1, aliases.size)
    assertEquals(JsonPrimitive("old"), secure.load(original.id)!!.values["state:token"])
  }

  private suspend fun assertEmpty(session: PrototypeStorageSession) {
    session.flush()
    assertNull(plain.stored(original.id))
    assertNull(secure.load(original.id))
    assertTrue(root.listFiles()!!.isEmpty())
    assertTrue(aliases.isEmpty())
    // Draining alone prevents resurrection, but the second guard must also skip stale secure I/O.
    assertEquals(0, secureSaves)
    assertTrue(session.report().secure!!.none { it.present })
  }
}

internal class ControllerSecureStore : PrototypeSecureValueStore {
  var value: PrototypeStoredValues? = null
  var beforeSave: () -> Unit = {}
  var deletes = 0

  override fun load(id: String) = value

  override fun save(id: String, stored: PrototypeStoredValues) {
    beforeSave()
    value = stored
  }

  override fun delete(id: String): Int {
    deletes++
    return (value?.values?.size ?: 0).also { value = null }
  }
}
