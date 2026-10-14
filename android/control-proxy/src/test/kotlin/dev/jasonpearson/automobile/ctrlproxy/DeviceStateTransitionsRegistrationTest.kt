package dev.jasonpearson.automobile.ctrlproxy

import android.content.ContextWrapper
import android.util.Log
import java.util.concurrent.Executor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
class DeviceStateTransitionsRegistrationTest {
  interface FakeCallback {
    fun onStateChanged(state: Int)
  }

  class FakeManager {
    var registered: FakeCallback? = null
    var unregistered: FakeCallback? = null
    var registrations = 0
    var registrationAttempts = 0
    var denyRegistration = false

    fun registerCallback(executor: Executor, callback: FakeCallback) {
      registrationAttempts++
      if (denyRegistration) throw SecurityException("registration denied")
      registrations++
      registered = callback
      executor.execute {
        callback.onStateChanged(0)
        callback.onStateChanged(1)
      }
    }

    fun unregisterCallback(callback: FakeCallback) {
      unregistered = callback
    }
  }

  class MissingRegisterManager

  class MissingUnregisterManager {
    var registrations = 0

    fun registerCallback(executor: Executor, callback: FakeCallback) {
      registrations++
      executor.execute { callback.onStateChanged(0) }
    }
  }

  private class FakeContext(private val service: Any?) : ContextWrapper(null) {
    override fun getSystemService(name: String): Any? {
      assertEquals("device_state", name)
      return service
    }

    override fun getMainExecutor(): Executor = Executor { it.run() }
  }

  @Before
  fun clearLogs() {
    ShadowLog.clear()
  }

  private fun loadClass(name: String): Class<*> =
    when (name) {
      "android.hardware.devicestate.DeviceStateManager" -> FakeManager::class.java
      "android.hardware.devicestate.DeviceStateManager\$DeviceStateCallback" ->
        FakeCallback::class.java
      else -> throw ClassNotFoundException(name)
    }

  private fun assertWarning(missing: String) {
    val logs = ShadowLog.getLogsForTag("CtrlProxyDeviceState")
    assertEquals(1, logs.size)
    assertEquals(Log.WARN, logs.single().type)
    assertTrue(logs.single().msg.contains(missing))
    assertTrue(logs.single().msg.contains("fold-posture events are lost"))
  }

  @Test
  fun `pre S does not probe or warn`() {
    val registration =
      DeviceStateTransitions.register(
        FakeContext(null),
        sdkInt = 30,
        loadClass = { error("pre S must not load classes") },
      ) {
        error("no state expected")
      }
    assertNull(registration)
    assertTrue(ShadowLog.getLogsForTag("CtrlProxyDeviceState").isEmpty())
  }

  @Test
  @Config(sdk = [31, 34, 35])
  fun `supported versions register transitions and unregister the same proxy`() {
    for (sdk in listOf(31, 34, 36)) {
      val manager = FakeManager()
      val states = mutableListOf<Int>()
      val registration =
        DeviceStateTransitions.register(FakeContext(manager), sdk, ::loadClass) { states += it }
      assertNotNull(registration)
      assertEquals(1, manager.registrations)
      assertEquals(listOf(1), states)
      registration!!.close()
      assertSame(manager.registered, manager.unregistered)
    }
    assertTrue(ShadowLog.getLogsForTag("CtrlProxyDeviceState").isEmpty())
  }

  @Test
  fun `missing class warns`() {
    assertNull(
      DeviceStateTransitions.register(
        FakeContext(null),
        sdkInt = 31,
        loadClass = { throw ClassNotFoundException(it) },
      ) {},
    )
    assertWarning("DeviceStateManager class")
  }

  @Test
  fun `callback must be an interface`() {
    assertNull(
      DeviceStateTransitions.register(
        FakeContext(FakeManager()),
        sdkInt = 31,
        loadClass = {
          if (it.endsWith("\$DeviceStateCallback")) Any::class.java else loadClass(it)
        },
      ) {},
    )
    assertWarning("not an interface")
  }

  @Test
  fun `missing registration method warns`() {
    assertNull(
      DeviceStateTransitions.register(
        FakeContext(null),
        sdkInt = 31,
        loadClass = {
          if (it.endsWith("\$DeviceStateCallback")) FakeCallback::class.java
          else MissingRegisterManager::class.java
        },
      ) {},
    )
    assertWarning("registerCallback(Executor, DeviceStateCallback)")
  }

  @Test
  fun `missing unregister method is detected before registration`() {
    val manager = MissingUnregisterManager()
    assertNull(
      DeviceStateTransitions.register(
        FakeContext(manager),
        sdkInt = 31,
        loadClass = {
          if (it.endsWith("\$DeviceStateCallback")) FakeCallback::class.java
          else MissingUnregisterManager::class.java
        },
      ) {},
    )
    assertEquals(0, manager.registrations)
    assertWarning("unregisterCallback(DeviceStateCallback)")
  }

  @Test
  fun `missing service warns`() {
    assertNull(DeviceStateTransitions.register(FakeContext(null), 31, ::loadClass) {})
    assertWarning("device_state service is missing")
  }

  @Test
  fun `registration security failure warns`() {
    val manager = FakeManager().apply { denyRegistration = true }
    assertNull(DeviceStateTransitions.register(FakeContext(manager), 31, ::loadClass) {})
    assertEquals(1, manager.registrationAttempts)
    assertEquals(0, manager.registrations)
    assertWarning("registerCallback invocation")
  }

  @Test
  fun `class access security failure warns`() {
    assertNull(
      DeviceStateTransitions.register(
        FakeContext(null),
        sdkInt = 31,
        loadClass = { throw SecurityException("class access denied") },
      ) {},
    )
    assertWarning("DeviceStateManager class access denied")
  }

  @Test
  fun `class linkage failure warns`() {
    assertNull(
      DeviceStateTransitions.register(
        FakeContext(null),
        sdkInt = 31,
        loadClass = { throw NoClassDefFoundError(it) },
      ) {},
    )
    assertWarning("DeviceStateManager class linkage failed")
  }
}
