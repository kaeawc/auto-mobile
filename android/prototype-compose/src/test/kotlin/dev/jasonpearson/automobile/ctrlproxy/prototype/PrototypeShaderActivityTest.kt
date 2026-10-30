package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Looper
import android.os.Trace
import androidx.compose.runtime.AbstractApplier
import androidx.compose.runtime.Composition
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Recomposer
import io.mockk.*
import kotlin.coroutines.EmptyCoroutineContext
import org.junit.AfterClass
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/** Runtime-only composition: no Android owner, UI nodes, frame scheduler or GPU. */
class PrototypeShaderActivityTest {
  private class FakeApplier : AbstractApplier<Unit>(Unit) {
    override fun insertTopDown(index: Int, instance: Unit) = Unit

    override fun insertBottomUp(index: Int, instance: Unit) = Unit

    override fun move(from: Int, to: Int, count: Int) = Unit

    override fun remove(index: Int, count: Int) = Unit

    override fun onClear() = Unit
  }

  private class Fixture {
    val session = PrototypeShaderSession()
    val registration = session.register("retained/child")
    private val recomposer = Recomposer(EmptyCoroutineContext)
    private val composition = Composition(FakeApplier(), recomposer)

    init {
      session.setVisible(true)
    }

    fun render(ancestorVisible: Boolean, visible: Boolean = true) {
      composition.setContent {
        CompositionLocalProvider(LocalPrototypeShadersVisible provides ancestorVisible) {
          // A visible nested retained subtree must still obey its hidden ancestor.
          CompositionLocalProvider(
            LocalPrototypeShadersVisible provides LocalPrototypeShadersVisible.current,
          ) {
            PrototypeShaderActivity(session, registration, visible)
          }
        }
      }
    }

    fun close() {
      composition.dispose()
      recomposer.cancel()
      session.unregister(registration)
    }
  }

  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      // The Android runtime artifact consults Looper/Trace even with no Android UI nodes.
      mockkStatic(Looper::class, Trace::class)
      val looper = mockk<Looper>()
      every { looper.thread } returns Thread.currentThread()
      every { Looper.getMainLooper() } returns looper
      every { Trace.beginSection(any()) } just Runs
      every { Trace.endSection() } just Runs
      Fixture().apply {
        render(true)
        render(false)
        close()
      }
    }

    @JvmStatic
    @AfterClass
    fun closePlatformStubs() {
      unmockkStatic(Looper::class, Trace::class)
    }
  }

  @Test
  fun `retained ancestor hides sampling and resume skips only the gap`() {
    val f = Fixture()
    try {
      f.render(true)
      assertTrue(f.session.sampling.value)
      f.session.frame(0)
      repeat(7) { assertTrue(f.session.frame((it + 1) * 25_000_000L)) }
      f.render(false)
      assertFalse(f.session.sampling.value)
      assertFalse(f.session.frame(5_000_000_000L))
      f.render(true)
      assertTrue(f.session.frame(5_000_000_000L))
      assertFalse(f.session.frame(5_025_000_000L))
      assertEquals(1, f.session.failures().size)
    } finally {
      f.close()
    }
    assertFalse(f.session.sampling.value)
    assertEquals(0, f.session.registeredCount)
  }

  @Test
  fun `visible ancestor does not activate a hidden or unprepared shader`() {
    val f = Fixture()
    try {
      f.render(true, visible = false)
      assertFalse(f.session.sampling.value)
      f.render(true)
      assertTrue(f.session.sampling.value)
      f.render(true, visible = false)
      assertFalse(f.session.sampling.value)
    } finally {
      f.close()
    }
  }
}
