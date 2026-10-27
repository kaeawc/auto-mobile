package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeReplacementMotionTest {
  @Test
  fun `only animated same id and replacing shows request a new window`() = runTest {
    val host = FakePrototypeHost()
    val controller =
      PrototypeController(
        host,
        PrototypeResultSink { _, success, error -> check(success) { error.orEmpty() } },
      )
    suspend fun show(
      id: String,
      motion: String?,
      transition: String,
      replaceOthers: Boolean = false,
    ) {
      controller.show(
        null,
        PrototypeSpec(
          id,
          PrototypeWindow(PrototypeFullscreenPlacement(), transition = transition),
          motion = motion,
          root = PrototypeTextNode(text = id),
        ),
        replaceOthers = replaceOthers,
      )
    }
    show("first", null, "fade")
    assertFalse(host.requests.last().bringToFront)
    show("first", "none", "fade")
    assertFalse(host.requests.last().bringToFront)
    show("first", "standard", "none")
    assertFalse(host.requests.last().bringToFront)
    show("first", "reduced", "fade")
    assertTrue(host.requests.last().bringToFront)
    show("second", "none", "fade", true)
    assertFalse(host.requests.last().bringToFront)
    show("third", "standard", "fade", true)
    assertTrue(host.requests.last().bringToFront)
  }
}
