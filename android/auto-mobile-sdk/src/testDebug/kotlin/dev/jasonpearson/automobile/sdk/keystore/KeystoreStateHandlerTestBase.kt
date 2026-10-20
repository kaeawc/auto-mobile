package dev.jasonpearson.automobile.sdk.keystore

import org.junit.After
import org.junit.Before
import org.robolectric.shadows.ShadowBinder

internal abstract class KeystoreStateHandlerTestBase {
  protected class FakeKeystoreBackend : KeystoreBackend {
    val entries = mutableMapOf<String, EntryCategory>()
    val calls = mutableListOf<String>()
    var failure: Exception? = null

    override fun containsAlias(alias: String): Boolean {
      calls.add("containsAlias:$alias")
      failure?.let { throw it }
      return alias in entries
    }

    override fun entryCategory(alias: String): EntryCategory {
      calls.add("entryCategory:$alias")
      return entries.getValue(alias)
    }
  }

  protected class FakeDeviceLockProbe(var locked: DeviceLockState = DeviceLockState.UNLOCKED) :
    DeviceLockProbe {
    var failure: Exception? = null
    var calls = 0

    override fun state(): DeviceLockState {
      calls++
      failure?.let { throw it }
      return locked
    }
  }

  protected val backend = FakeKeystoreBackend()
  protected val probe = FakeDeviceLockProbe()
  protected val handler = KeystoreStateHandler(backend, probe)

  @Before
  fun setUp() {
    KeystoreTestState.reset()
  }

  @After
  fun tearDown() {
    KeystoreTestState.reset()
    ShadowBinder.reset()
  }

  protected fun enable() {
    KeystoreTestState.declareScope("fixture", setOf("aes", "private", "cert", "unknown", "missing"))
    KeystoreTestState.setEnabled(true)
  }
}
