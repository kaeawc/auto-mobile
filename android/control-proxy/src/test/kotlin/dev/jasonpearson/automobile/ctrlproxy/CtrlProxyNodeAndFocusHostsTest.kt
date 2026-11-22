package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The [CtrlProxyNodeActionHost] and [CtrlProxyFocusHost] seams forward to an unconnected service:
 * with no windows and no active root they report nothing rather than throwing (#11876).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class CtrlProxyNodeAndFocusHostsTest {
  private lateinit var service: CtrlProxy

  @Before
  fun setUp() {
    service = Robolectric.buildService(CtrlProxy::class.java).get()
  }

  @Test
  fun nodeActionHostFindsNothingWithoutWindows() {
    val host = CtrlProxyNodeActionHost(service)

    assertNull(host.activeWindowRoot())
    assertNull(host.findNodeInDisplayWindows { it })
    assertTrue(host.findNodesInDisplayWindows { listOf(it) }.isEmpty())
  }

  @Test
  fun nodeActionHostCreatesViewsOnTheService() {
    val view = CtrlProxyNodeActionHost(service).createView()

    assertSame(service, view.context)
  }

  @Test
  fun focusHostHasNoOverlayBeforeServiceConnects() {
    val host = CtrlProxyFocusHost(service)

    assertNull(host.currentOverlayDrawer())
    assertNull(host.findAccessibilityFocusedNode())
  }

  @Test
  fun focusHostTraversalOrderIsNullWithoutWindowsOrRoot() {
    assertNull(CtrlProxyFocusHost(service).extractTraversalOrder())
  }

  @Test
  fun overlayDrawerOrNullMatchesTheFocusHost() {
    assertEquals(service.overlayDrawerOrNull, CtrlProxyFocusHost(service).currentOverlayDrawer())
  }
}
