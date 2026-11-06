package dev.jasonpearson.automobile.sdk.keystore

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before

internal abstract class KeystoreFaultTestBase : KeystoreStateHandlerTestBase() {
  protected class RecordingSleeper : KeystoreSleeper {
    val delays = mutableListOf<Long>()

    override fun sleep(delayMs: Long) {
      delays.add(delayMs)
    }
  }

  protected val sleeper = RecordingSleeper()
  protected val faultingBackend = FaultingKeystoreBackend(backend, sleeper)
  protected val allowedHandler = KeystoreStateHandler(faultingBackend, probe) { true }
  protected val deniedHandler = KeystoreStateHandler(faultingBackend, probe)

  @Before
  fun clearPlanBeforeTest() {
    KeystoreFaultPlan.clearAll()
  }

  @After
  fun clearPlanAfterTest() {
    KeystoreFaultPlan.clearAll()
  }

  protected fun inject(kind: String, alias: String = "aes", delayMs: Long? = null): JSONObject =
    allowedHandler.handle("injectFault", "fixture", alias, kind, delayMs)

  protected fun metadata(alias: String = "aes"): JSONObject =
    allowedHandler.handle("metadata", "fixture", alias)

  protected fun assertRefusal(result: JSONObject, outcome: String, reason: String) {
    assertEquals(outcome, result.getString("outcome"))
    assertEquals(reason, result.getString("reason"))
    assertFalse(result.has("aliases"))
  }
}
