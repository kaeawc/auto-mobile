package dev.jasonpearson.automobile.ctrlproxy.overlay

import org.junit.Assert.*
import org.junit.Test

internal class FakeOverlayBackRegistrar : OverlayBackCallbackRegistrar {
  val calls = mutableListOf<String>()
  var available = true
  var callback: (() -> Unit)? = null

  override fun register(onBack: () -> Unit): Boolean {
    calls += "register"
    if (!available) return false
    callback = onBack
    return true
  }

  override fun unregister() {
    calls += "unregister"
    callback = null
  }
}

/** When the predictive-back callback may be registered: only while focusable, only on API 33+. */
class OverlayBackBindingTest {
  private val registrar = FakeOverlayBackRegistrar()
  private var backs = 0

  private fun binding(sdk: Int) = OverlayBackBinding(sdk, registrar) { backs++ }

  @Test
  fun `registers while focusable and unregisters when focus is removed`() {
    val binding = binding(34)
    binding.sync(false)
    assertTrue(registrar.calls.isEmpty())
    binding.sync(true)
    binding.sync(true) // Unchanged: no second registration.
    assertEquals(listOf("register"), registrar.calls)
    registrar.callback!!()
    assertEquals(1, backs)
    binding.sync(false)
    assertEquals(listOf("register", "unregister"), registrar.calls)
    assertNull(registrar.callback)
  }

  @Test
  fun `release unregisters once and a released binding stays quiet`() {
    val binding = binding(36)
    binding.sync(true)
    binding.release()
    binding.release()
    assertEquals(listOf("register", "unregister"), registrar.calls)
    assertFalse(binding.registered)
  }

  @Test
  fun `below API 33 nothing is ever registered`() {
    val binding = binding(32)
    binding.sync(true)
    binding.sync(false)
    binding.release()
    assertTrue(registrar.calls.isEmpty())
  }

  @Test
  fun `a window without a dispatcher yet is retried on the next sync`() {
    val binding = binding(33)
    registrar.available = false
    binding.sync(true)
    assertFalse(binding.registered)
    registrar.available = true
    binding.sync(true)
    assertTrue(binding.registered)
    assertEquals(listOf("register", "register"), registrar.calls)
  }
}
