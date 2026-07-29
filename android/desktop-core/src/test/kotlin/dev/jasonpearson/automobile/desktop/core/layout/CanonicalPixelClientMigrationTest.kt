package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenGeometry
import dev.jasonpearson.automobile.desktop.domain.ElementBounds
import dev.jasonpearson.automobile.desktop.domain.UIElementInfo
import dev.jasonpearson.automobile.desktop.domain.ViewportPoint
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * The client half of the canonical-pixel campaign (issue #4550): the daemon's declared coordinate
 * space has to reach the frame facts the control policy decides on, and the INSPECTOR rendering
 * that shares those messages has to be unaffected by the unit change.
 *
 * The second half is why this file exists rather than only the policy test. The IDE plugin embeds
 * the same `DeviceScreenView` and never enables control mode, so its only exposure to canonical
 * pixels is through rendering. The claim "the ratio-based fit makes display invariant" is checked
 * here against the real mapper rather than assumed.
 */
class CanonicalPixelClientMigrationTest {

  // ---- Threading: stream declaration -> frame facts -------------------------

  @Test
  fun `the screenshot declaration reaches the screenshot frame facts`() {
    val state = LayoutInspectorState()

    state.updateScreenshot(
      data = byteArrayOf(1),
      width = 1170,
      height = 2532,
      timestamp = 1L,
      deviceId = "sim-udid",
      captureSequence = 7L,
      coordinateSpace = CoordinateSpace.Pixels,
      nativeScale = 3.5,
    )

    assertEquals(CoordinateSpace.Pixels, state.screenshotFacts?.coordinateSpace)
    assertEquals(3.5, state.screenshotFacts?.nativeScale)
  }

  @Test
  fun `the hierarchy declaration reaches the hierarchy frame facts`() {
    val state = LayoutInspectorState()

    state.updateHierarchy(
      newHierarchy = LayoutInspectorMockData.mockHierarchy,
      deviceId = "sim-udid",
      captureSequence = 7L,
      coordinateSpace = CoordinateSpace.Pixels,
      nativeScale = 3.5,
    )

    assertEquals(CoordinateSpace.Pixels, state.hierarchyFacts?.coordinateSpace)
    assertEquals(3.5, state.hierarchyFacts?.nativeScale)
  }

  @Test
  fun `an undeclared update leaves the facts on the legacy space`() {
    // A pre-#4548 runner's frames must not acquire a declaration on the way through the client.
    val state = LayoutInspectorState()

    state.updateScreenshot(data = byteArrayOf(1), width = 1080, height = 2340, timestamp = 1L)
    state.updateHierarchy(newHierarchy = LayoutInspectorMockData.mockHierarchy)

    assertNull(state.screenshotFacts?.coordinateSpace)
    assertNull(state.hierarchyFacts?.coordinateSpace)
  }

  // ---- Inspector rendering invariance (the ide-plugin regression check) -----

  /**
   * The inspector's overlay placement, reproduced from `DeviceScreenView`: the fitted frame comes
   * from the SCREENSHOT's pixel dimensions (unchanged by this campaign — a screenshot was always
   * pixels), and an element's position comes from mapping its bounds through the hierarchy root's
   * dimensions. Both sides of that second ratio are hierarchy geometry, so a uniform `nativeScale`
   * cancels.
   */
  private fun overlayTopLeft(
    element: ElementBounds,
    rootWidth: Int,
    rootHeight: Int,
    imageWidth: Int,
    imageHeight: Int,
  ): ViewportPoint {
    val frame =
      DeviceScreenCoordinateMapper.fitToViewport(
        imageWidth = imageWidth,
        imageHeight = imageHeight,
        viewportWidth = 900f,
        viewportHeight = 1400f,
      )
    val geometry =
      DeviceScreenGeometry(
        frameWidthPx = frame.widthPx,
        frameHeightPx = frame.heightPx,
        scale = 0.8f,
        offsetX = 17f,
        offsetY = 23f,
        deviceWidth = rootWidth,
        deviceHeight = rootHeight,
      )
    return DeviceScreenCoordinateMapper.deviceToViewport(element.left, element.top, geometry)
  }

  @Test
  fun `element overlays land in the same place whether bounds are points or canonical pixels`() {
    // iOS at 3x. Before #4549 the hierarchy reported 390x844 points; now it reports 1170x2532
    // pixels for the same screen, and every element scales with it. The screenshot is the same
    // 1170x2532 PNG in both cases.
    val points = ElementBounds(left = 16, top = 100, right = 120, bottom = 144)
    val pixels = ElementBounds(left = 48, top = 300, right = 360, bottom = 432)

    val legacy = overlayTopLeft(points, 390, 844, imageWidth = 1170, imageHeight = 2532)
    val canonical = overlayTopLeft(pixels, 1170, 2532, imageWidth = 1170, imageHeight = 2532)

    assertTrue(
      abs(legacy.x - canonical.x) < 0.001f && abs(legacy.y - canonical.y) < 0.001f,
      "overlay drifted: legacy=$legacy canonical=$canonical",
    )
  }

  @Test
  fun `hit testing resolves the same element whether bounds are points or canonical pixels`() {
    // The inverse direction, which is what a click in the IDE plugin's inspector runs through.
    val frame =
      DeviceScreenCoordinateMapper.fitToViewport(
        imageWidth = 1170,
        imageHeight = 2532,
        viewportWidth = 900f,
        viewportHeight = 1400f,
      )
    fun geometry(deviceWidth: Int, deviceHeight: Int) =
      DeviceScreenGeometry(
        frameWidthPx = frame.widthPx,
        frameHeightPx = frame.heightPx,
        scale = 0.8f,
        offsetX = 17f,
        offsetY = 23f,
        deviceWidth = deviceWidth,
        deviceHeight = deviceHeight,
      )

    val click = ViewportPoint(300f, 500f)
    val inPoints = DeviceScreenCoordinateMapper.viewportToDevice(click, geometry(390, 844))
    val inPixels = DeviceScreenCoordinateMapper.viewportToDevice(click, geometry(1170, 2532))

    // The same physical location: the pixel coordinate is the point coordinate times nativeScale,
    // within the rounding the mapper applies on each side.
    assertTrue(abs(inPixels.x - inPoints.x * 3) <= 2, "x drifted: $inPoints vs $inPixels")
    assertTrue(abs(inPixels.y - inPoints.y * 3) <= 2, "y drifted: $inPoints vs $inPixels")

    // And it lands inside the same element either way.
    val elementInPoints = ElementBounds(left = 16, top = 100, right = 200, bottom = 220)
    val elementInPixels = ElementBounds(left = 48, top = 300, right = 600, bottom = 660)
    assertEquals(
      elementInPoints.contains(inPoints.x, inPoints.y),
      elementInPixels.contains(inPixels.x, inPixels.y),
    )
  }

  @Test
  fun `screenshot rotation detection is unaffected by the unit change`() {
    // detectScreenshotRotation compares ORIENTATIONS, so a uniform positive scale of the bounds
    // cannot change its answer — the rotation the renderer applies is identical under either space.
    assertEquals(
      DeviceScreenCoordinateMapper.detectScreenshotRotation(1170, 2532, 844, 390),
      DeviceScreenCoordinateMapper.detectScreenshotRotation(1170, 2532, 2532, 1170),
    )
    assertEquals(
      DeviceScreenCoordinateMapper.detectScreenshotRotation(1170, 2532, 390, 844),
      DeviceScreenCoordinateMapper.detectScreenshotRotation(1170, 2532, 1170, 2532),
    )
  }

  @Test
  fun `the tap-target overlay threshold scales with the screen it is derived from`() {
    // findNonCompliantTapTargets is the one inspector overlay that compares an element's bounds
    // against a threshold derived from the SCREEN size rather than against other bounds. It stays
    // self-consistent under canonical pixels because both inputs scale together: a 44pt control on
    // a 390pt-wide screen and the same control as 132px on a 1170px-wide screen get the same
    // verdict. (What canonical pixels FIXED is the iOS case where the screen dimensions were
    // already pixels while the bounds were still points — see the PR description.)
    val small = clickable(ElementBounds(left = 0, top = 0, right = 44, bottom = 44))
    val smallScaled = clickable(ElementBounds(left = 0, top = 0, right = 132, bottom = 132))

    assertEquals(
      findNonCompliantTapTargets(small, 390, 844).size,
      findNonCompliantTapTargets(smallScaled, 1170, 2532).size,
    )

    val large = clickable(ElementBounds(left = 0, top = 0, right = 120, bottom = 120))
    val largeScaled = clickable(ElementBounds(left = 0, top = 0, right = 360, bottom = 360))
    assertEquals(
      findNonCompliantTapTargets(large, 390, 844).size,
      findNonCompliantTapTargets(largeScaled, 1170, 2532).size,
    )
  }

  private fun clickable(bounds: ElementBounds): UIElementInfo =
    UIElementInfo(
      id = "target",
      className = "XCUIElementTypeButton",
      resourceId = "submit",
      text = null,
      contentDescription = null,
      bounds = bounds,
      isClickable = true,
      isEnabled = true,
      isFocused = false,
      isSelected = false,
      isScrollable = false,
      isCheckable = false,
      isChecked = false,
      children = emptyList(),
      depth = 0,
    )
}
