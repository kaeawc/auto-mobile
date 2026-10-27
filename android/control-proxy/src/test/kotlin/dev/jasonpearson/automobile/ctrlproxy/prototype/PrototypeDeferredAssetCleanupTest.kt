package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeDeferredAssetCleanupTest {
  private val worker = TestScope()
  private val host = FakePrototypeHost()
  private var clears = 0
  private val controller =
    PrototypeController(
      host,
      PrototypeResultSink { _, success, error -> check(success) { error.orEmpty() } },
      clearAssets = { clears++ },
      requestScope = worker,
    )

  private fun spec() =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeTextNode(text = "Panel"),
    )

  @Test
  fun `last exit schedules cleanup on the injected worker after leaving its monitor`() = runTest {
    controller.show(null, spec())
    val exits = checkNotNull(host.requests.last().exitResources)
    val owner = Any()
    exits.retain(owner)
    controller.dismiss(null, "panel", null)
    worker.runCurrent()
    assertEquals(0, clears)
    exits.release(owner)
    assertEquals(0, clears)
    worker.runCurrent()
    assertEquals(1, clears)
  }

  @Test
  fun `queued cleanup waits for a show mutex and preserves the new surface assets`() = runTest {
    controller.show(null, spec())
    controller.dismiss(null, "panel", null)
    val gate = CompletableDeferred<Unit>()
    host.beforeShow = { gate.await() }
    val show = launch(start = CoroutineStart.UNDISPATCHED) { controller.show(null, spec()) }
    worker.runCurrent()
    assertEquals(0, clears)
    gate.complete(Unit)
    show.join()
    worker.runCurrent()
    assertEquals(0, clears)
  }

  @Test
  fun `teardown cleanup survives cancellation of the request scope`() = runTest {
    controller.show(null, spec())
    worker.cancel()
    controller.destroy()
    worker.runCurrent()
    assertEquals(1, clears)
  }
}
