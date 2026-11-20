package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeRequires
import dev.jasonpearson.automobile.protocol.PrototypeResult
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeStorageBlock
import dev.jasonpearson.automobile.protocol.PrototypeTextNode
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import dev.jasonpearson.automobile.protocol.SavedPrototypeErrorCode
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A saved-prototype delete keeps an open screen's storage session usable when it fails (#14321).
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class SavedPrototypeDeleteSessionTest {
  private val store = FakeSavedPrototypeStore { 42L }
  private val replies = mutableListOf<PrototypeResult>()
  private val sink =
    object : PrototypeResultSink {
      override suspend fun send(requestId: String?, success: Boolean, error: String?) {
        replies += PrototypeResult(0, requestId, success, error)
      }

      override suspend fun sendRefusal(
        requestId: String?,
        code: SavedPrototypeErrorCode,
        error: String,
      ) {
        replies += PrototypeResult(0, requestId, false, error = error, errorCode = code)
      }
    }
  private val assets =
    object : PrototypeAssetSource {
      override fun lookup(id: String): PrototypeAssetInfo? = null

      override fun read(id: String): ByteArray? = null

      override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit
    }

  private fun TestScope.controller(
    backing: SavedPrototypeStore,
    sessions: PrototypeStorageSessionRegistry,
    clearStorage: suspend (String) -> Int,
  ) =
    SavedPrototypeController(
      backing,
      assets,
      FakeSavedPrototypeShortcuts(),
      sink,
      UnconfinedTestDispatcher(testScheduler),
      FakePrototypeShortcutPinner(),
      clearStorage,
      sessions,
    )

  private fun storageController(
    sessions: PrototypeStorageSessionRegistry,
    plain: PrototypeStorageStore,
    secure: PrototypeSecureValueStore,
  ) =
    PrototypeController(
      FakePrototypeHost(),
      sink,
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      storage = PrototypeStoragePersistence(plain, FakePrototypeTimer(), EmptyCoroutineContext),
      purgeSecureStorage = { id -> secure.delete(id) },
      storageSessions = sessions,
    )

  private fun onlyReply(id: String): PrototypeResult {
    assertEquals(1, replies.size)
    return replies.single().also { assertEquals(id, it.requestId) }
  }

  private fun secureSpec() =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeTextNode(text = "Vault"),
      requires = PrototypeRequires(platform = listOf("secureStorage")),
      state = mapOf("token" to PrototypeScalar.Text(""), "count" to PrototypeScalar.Numeric(0.0)),
      storage = PrototypeStorageBlock(1, listOf("state:count"), secure = listOf("state:token")),
    )

  private suspend fun openSecureSession(
    registry: PrototypeStorageSessionRegistry,
    plain: FakePrototypeStorageStore,
    secure: ControllerSecureStore,
    timer: FakePrototypeTimer,
  ): PrototypeStorageSession {
    val original = secureSpec()
    val session =
      PrototypeStoragePersistence(
          PrototypeStorageBackends(plain, secure),
          timer,
          EmptyCoroutineContext,
          registry = registry,
        )
        .open(original)
        .session!!
    session.record(
      original.copy(
        state =
          mapOf("token" to PrototypeScalar.Text("secret"), "count" to PrototypeScalar.Numeric(1.0)),
      ),
    )
    session.flush()
    assertTrue(plain.stored(original.id) != null && secure.value != null)
    return session
  }

  @Test
  fun `a failed entry delete after storage cleanup restores both backends on resume`() = runTest {
    val registry = PrototypeStorageSessionRegistry()
    val plain = FakePrototypeStorageStore()
    val secure = ControllerSecureStore()
    val session = openSecureSession(registry, plain, secure, FakePrototypeTimer())
    val storageController = storageController(registry, plain, secure)
    var cleanups = 0
    val controller =
      controller(
        backing =
          object : SavedPrototypeStore by store {
            override fun delete(id: String): Boolean = throw java.io.IOException("disk")
          },
        sessions = registry,
        clearStorage = {
          cleanups++
          storageController.clearStoredValues(it, keepSessionValues = true)
        },
      )
    controller.save("save", secureSpec(), "Vault", null)
    replies.clear()

    controller.delete("delete", "panel")

    assertEquals(SavedPrototypeErrorCode.INTERNAL_ERROR, onlyReply("delete").errorCode)
    assertEquals(1, cleanups)
    // Cleanup emptied both backends; the resumed session still holds what it had.
    assertEquals(null, secure.value)
    assertEquals(null, plain.stored("panel"))
    assertTrue(session.report().secure!!.single().present)
    session.flush()
    assertEquals(
      JsonPrimitive("secret"),
      secure.value!!.values["state:token"],
    )
    assertEquals(
      JsonPrimitive(1),
      plain.stored("panel")!!.values["state:count"],
    )
  }

  @Test
  fun `an Error escaping delete still releases the quiesce hold`() = runTest {
    for (failStoreDelete in listOf(false, true)) {
      val registry = PrototypeStorageSessionRegistry()
      val plain = FakePrototypeStorageStore()
      val secure = ControllerSecureStore()
      val session = openSecureSession(registry, plain, secure, FakePrototypeTimer())
      val controller =
        controller(
          backing =
            object : SavedPrototypeStore by store {
              override fun delete(id: String): Boolean =
                if (failStoreDelete) throw FatalTestError() else store.delete(id)
            },
          sessions = registry,
          clearStorage = { if (failStoreDelete) 0 else throw FatalTestError() },
        )
      try {
        controller.delete("delete", "panel")
        fail("Expected the Error to propagate")
      } catch (_: FatalTestError) {}
      // A leaked hold would keep this write quiesced forever.
      session.record(
        secureSpec()
          .copy(
            state =
              mapOf(
                "token" to PrototypeScalar.Text("later"),
                "count" to PrototypeScalar.Numeric(2.0),
              ),
          ),
      )
      session.flush()
      assertEquals(
        JsonPrimitive("later"),
        secure.value!!.values["state:token"],
      )
    }
  }
}

/** A non-Exception Throwable, like a VirtualMachineError escaping the store. */
private class FatalTestError : Error()
