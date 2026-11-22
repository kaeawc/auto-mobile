package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class PrototypeCardBlurCleanupTest {
  private class FakeFailedAttach(
    override val showing: Boolean,
    override val decorAttached: Boolean,
    private val failClearBlur: Boolean = false,
  ) : PrototypeFailedCardAttach {
    val calls = mutableListOf<String>()

    override fun clearBlur() {
      calls += "clearBlur"
      check(!failClearBlur) { "clear failed" }
    }

    override fun dismiss() {
      calls += "dismiss"
    }

    override fun removeDecor() {
      calls += "removeDecor"
    }

    override fun releaseView() {
      calls += "releaseView"
    }
  }

  private fun release(attach: FakeFailedAttach): RuntimeException {
    val error = IllegalStateException("show rejected")
    try {
      releaseFailedPrototypeCardAttach(error, attach)
    } catch (thrown: RuntimeException) {
      return thrown
    }
  }

  @Test
  fun `a rejected show that never attached the decor still clears the blur radius`() {
    val attach = FakeFailedAttach(showing = false, decorAttached = false)
    assertEquals("show rejected", release(attach).message)
    assertEquals(listOf("clearBlur", "releaseView"), attach.calls)
  }

  @Test
  fun `an attached decor is removed and a showing dialog dismissed after clearing blur`() {
    val decor = FakeFailedAttach(showing = false, decorAttached = true)
    release(decor)
    assertEquals(listOf("clearBlur", "removeDecor", "releaseView"), decor.calls)
    val showing = FakeFailedAttach(showing = true, decorAttached = true)
    release(showing)
    assertEquals(listOf("clearBlur", "dismiss", "releaseView"), showing.calls)
  }

  @Test
  fun `a failing blur reset is suppressed and cleanup continues`() {
    val attach = FakeFailedAttach(showing = true, decorAttached = true, failClearBlur = true)
    val thrown = release(attach)
    assertEquals("show rejected", thrown.message)
    assertSame(IllegalStateException::class.java, thrown.suppressed.single().javaClass)
    assertEquals(listOf("clearBlur", "dismiss", "releaseView"), attach.calls)
  }
}
