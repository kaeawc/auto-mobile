package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.app.ActivityOptionsCompat
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AndroidPermissionsLifecycleTest {
  private class Registry : ActivityResultRegistry() {
    var requestCode = 0
    var fail = false
    var input: Any? = null

    override fun <I, O> onLaunch(
      requestCode: Int,
      contract: ActivityResultContract<I, O>,
      input: I,
      options: ActivityOptionsCompat?,
    ) {
      this.requestCode = requestCode
      this.input = input
      check(!fail) { "Cannot launch permission dialog" }
    }
  }

  @Test
  fun `Activity destroy cancels registration and a late result is dropped`() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val registry = Registry()
    val gateway = FrameworkPermissionsGateway(controller.get(), registry)
    val results = mutableListOf<Boolean>()
    var cancellations = 0
    val unregister = gateway.request({ results += it }, { cancellations++ })!!
    assertNull(gateway.request({ error("Second dialog opened") }, {}))
    controller.pause().stop().destroy()
    assertEquals(1, cancellations)
    registry.dispatchResult(registry.requestCode, true)
    assertTrue(results.isEmpty())
    unregister()
    assertEquals(1, cancellations)
  }

  @Test
  fun `launch failure releases registration and Activity prompt ownership`() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val registry = Registry().apply { fail = true }
    val gateway = FrameworkPermissionsGateway(controller.get(), registry)
    val results = mutableListOf<Boolean>()
    assertTrue(runCatching { gateway.request({ results += it }, {}) }.isFailure)
    val failedRequestCode = registry.requestCode
    registry.fail = false
    val unregister = gateway.request({ results += it }, {})!!
    registry.dispatchResult(failedRequestCode, false)
    assertTrue(results.isEmpty())
    registry.dispatchResult(registry.requestCode, true)
    assertEquals(listOf(true), results)
    unregister()
    controller.pause().stop().destroy()
  }

  @Test
  fun `capture gateways share the Activity prompt and request their own permission`() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val registry = Registry()
    val slot = PrototypePromptSlot()
    val camera =
      FrameworkPermissionsGateway(
        controller.get(),
        registry,
        PrototypeRuntimePermission.CAMERA,
        slot,
      )
    val microphone =
      FrameworkPermissionsGateway(
        controller.get(),
        registry,
        PrototypeRuntimePermission.MICROPHONE,
        slot,
      )
    val unregister = camera.request({}, {})!!
    assertEquals("android.permission.CAMERA", registry.input)
    assertNull(microphone.request({ error("Second dialog opened") }, {}))
    unregister()
    microphone.request({}, {})!!()
    assertEquals("android.permission.RECORD_AUDIO", registry.input)
    controller.pause().stop().destroy()
  }

  @Test
  fun `a delivered result settles the Activity prompt until the next resume`() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val registry = Registry()
    val slot = PrototypePromptSlot()
    val camera =
      FrameworkPermissionsGateway(
        controller.get(),
        registry,
        PrototypeRuntimePermission.CAMERA,
        slot,
      )
    val microphone =
      FrameworkPermissionsGateway(
        controller.get(),
        registry,
        PrototypeRuntimePermission.MICROPHONE,
        slot,
      )
    controller.pause()
    val unregister = camera.request({}, {})!!
    assertTrue(microphone.prompting)
    registry.dispatchResult(registry.requestCode, true)
    unregister()
    assertFalse(microphone.prompting)
    assertTrue(microphone.settling)
    controller.resume()
    assertFalse(microphone.settling)
    // The resume cleared it without any status read, so a later background request is not held.
    controller.pause()
    assertFalse(microphone.settling)
    controller.pause().stop().destroy()
  }
}
