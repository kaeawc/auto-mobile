package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.Gravity
import androidx.compose.ui.unit.IntOffset
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** A floating window follows its anchored root onto the anchor's screen position (#9316). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeAnchorWindowTest {
  private lateinit var main: FakePrototypeMainThread
  private lateinit var manager: RecordingPrototypeWindowManager
  private lateinit var host: DefaultPrototypeHost

  @Before
  fun setUp() {
    val history = mutableListOf<String>()
    main = FakePrototypeMainThread()
    manager = RecordingPrototypeWindowManager(main, history)
    host =
      DefaultPrototypeHost(
        RuntimeEnvironment.getApplication(),
        manager,
        sdkInt = 30,
        mainThread = main,
        settleTimer = FakePrototypeSettleTimer(history),
        densityProvider = { 2.625f },
        backScope = CoroutineScope(Dispatchers.Unconfined),
      )
  }

  private val floating =
    PrototypeRequest(
      PrototypePlacement.Floating(Gravity.CENTER, offsetXDp = 24f, offsetYDp = 120f),
    )

  @Test
  fun `the anchored root moves a floating window to the anchor once, after layout`() = runTest {
    host.show(floating)
    val move = checkNotNull(host.currentWindowGeometry()?.moveTo)
    move(IntOffset(550, 1589))
    // Posted, not applied inside the layout pass that reported it.
    assertEquals(0, manager.updated.size)
    main.drain()
    val moved = manager.updated.single()
    assertEquals(Gravity.TOP or Gravity.START, moved.gravity)
    assertEquals(550, moved.x)
    assertEquals(1589, moved.y)
    // The relayout the move causes reports the same origin again: nothing more is sent.
    move(IntOffset(550, 1589))
    main.drain()
    assertEquals(1, manager.updated.size)
  }

  @Test
  fun `relayout keeps the anchored position and a replaced spec starts from its placement`() =
    runTest {
      host.show(floating)
      checkNotNull(host.currentWindowGeometry()?.moveTo)(IntOffset(550, 1589))
      main.drain()
      host.relayout()
      assertEquals(550, manager.updated.last().x)
      assertEquals(1589, manager.updated.last().y)
      host.replace(floating.copy(opacityPercent = 50))
      assertEquals(Gravity.CENTER, manager.updated.last().gravity)
      assertEquals((24 * 2.625f).toInt(), manager.updated.last().x)
    }

  @Test
  fun `fullscreen and sheet windows never move to an anchor`() = runTest {
    host.show(PrototypeRequest(PrototypePlacement.Fullscreen()))
    assertNull(host.currentWindowGeometry()?.moveTo)
    host.show(PrototypeRequest(PrototypePlacement.Sheet(PrototypePlacement.Edge.BOTTOM, 200f)))
    assertNull(host.currentWindowGeometry()?.moveTo)
  }
}
