package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenGeometry
import dev.jasonpearson.automobile.desktop.domain.ViewportPoint
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Coverage for the Compose-free viewport <-> device coordinate mapper extracted from
 * `DeviceScreenView` for milestone 28 (Client Screen Control), issue #3346. These tests exercise
 * the mapping without rendering a real device or connecting to the daemon, and pin the contract a
 * third-party client must reproduce: scale, pan, aspect fit, rotation, rounding, and out-of-bounds.
 */
class DeviceScreenCoordinateMapperTest {

  private val mapper = DeviceScreenCoordinateMapper

  /** A 1080x2340 device rendered 1:1 into a 540x1170 frame (frame is half device size). */
  private fun geometry(
    frameWidthPx: Float = 540f,
    frameHeightPx: Float = 1170f,
    scale: Float = 1f,
    offsetX: Float = 0f,
    offsetY: Float = 0f,
    deviceWidth: Int = 1080,
    deviceHeight: Int = 2340,
  ) =
    DeviceScreenGeometry(
      frameWidthPx = frameWidthPx,
      frameHeightPx = frameHeightPx,
      scale = scale,
      offsetX = offsetX,
      offsetY = offsetY,
      deviceWidth = deviceWidth,
      deviceHeight = deviceHeight,
    )

  // ---- Control-mode contract ------------------------------------------------

  @Test
  fun `inspector is the default mode name ordering (opt-in control)`() {
    // Inspector must be the first / default so the enum's natural default preserves today's
    // behavior for consumers that do not opt in.
    assertEquals(DeviceScreenControlMode.Inspector, DeviceScreenControlMode.values().first())
  }

  // ---- Scale (zoom) ---------------------------------------------------------

  @Test
  fun `viewportToDevice maps frame pixels to device pixels at scale 1`() {
    // Frame is half device size, so the frame center (270,585) is the device center (540,1170).
    val p = mapper.viewportToDevice(ViewportPoint(270f, 585f), geometry())
    assertEquals(540, p.x)
    assertEquals(1170, p.y)
    assertTrue(p.inBounds)
  }

  @Test
  fun `viewportToDevice removes zoom scale`() {
    // At scale 2, a viewport point twice as far from the origin maps to the same device point.
    val p = mapper.viewportToDevice(ViewportPoint(540f, 1170f), geometry(scale = 2f))
    assertEquals(540, p.x)
    assertEquals(1170, p.y)
  }

  // ---- Pan ------------------------------------------------------------------

  @Test
  fun `viewportToDevice removes pan offset`() {
    // Panned right/down by (100,50): the device origin now sits at viewport (100,50).
    val p =
      mapper.viewportToDevice(ViewportPoint(100f, 50f), geometry(offsetX = 100f, offsetY = 50f))
    assertEquals(0, p.x)
    assertEquals(0, p.y)
    assertTrue(p.inBounds)
  }

  @Test
  fun `viewportToDevice combines pan and zoom`() {
    val g = geometry(scale = 2f, offsetX = 100f, offsetY = 50f)
    // frameX = (viewport - offset) / scale ; device = frameX * (1080/540) = frameX * 2
    // viewport (100 + 2*135, 50 + 2*292.5) -> frame (135, 292.5) -> device (270, 585)
    val p = mapper.viewportToDevice(ViewportPoint(100f + 270f, 50f + 585f), g)
    assertEquals(270, p.x)
    assertEquals(585, p.y)
  }

  // ---- Aspect fit sizing ----------------------------------------------------

  @Test
  fun `fitToViewport is height-constrained for a tall device in a square viewport`() {
    // 1080x2340 (aspect 2.166) in an 800x800 viewport, padding 32 -> max frame 736x736.
    val frame = mapper.fitToViewport(1080, 2340, 800f, 800f)
    // Height-constrained: height = 736, width = 736 / 2.1666 = 339.7
    assertEquals(736f, frame.heightPx, 0.01f)
    assertEquals(736f / (2340f / 1080f), frame.widthPx, 0.01f)
    // Aspect ratio preserved.
    assertEquals(2340f / 1080f, frame.heightPx / frame.widthPx, 0.001f)
  }

  @Test
  fun `fitToViewport is width-constrained for a tall device in a narrow tall viewport`() {
    // 1080x2340 in a 400x2000 viewport -> width is the limiting side.
    val frame = mapper.fitToViewport(1080, 2340, 400f, 2000f)
    assertEquals(400f - 64f, frame.widthPx, 0.01f) // 336
    assertEquals((400f - 64f) * (2340f / 1080f), frame.heightPx, 0.01f)
  }

  @Test
  fun `fitToViewport preserves aspect ratio for a landscape image`() {
    val frame = mapper.fitToViewport(2340, 1080, 1200f, 1200f)
    assertEquals(1080f / 2340f, frame.heightPx / frame.widthPx, 0.001f)
  }

  @Test
  fun `fitScale never scales above one and clamps to floor`() {
    // Frame already fits comfortably -> capped at 1.0.
    assertEquals(1f, mapper.fitScale(300f, 600f, 800f, 1200f))
    // Frame far larger than viewport -> clamped to the 0.3 floor.
    assertEquals(0.3f, mapper.fitScale(5000f, 5000f, 400f, 400f))
  }

  // ---- Rotation detection ---------------------------------------------------

  @Test
  fun `detectScreenshotRotation returns zero when orientations agree`() {
    assertEquals(0, mapper.detectScreenshotRotation(1080, 2340, 1080, 2340))
    assertEquals(0, mapper.detectScreenshotRotation(2340, 1080, 2340, 1080))
  }

  @Test
  fun `detectScreenshotRotation rotates a portrait screenshot with landscape bounds`() {
    // Portrait image, landscape hierarchy -> 90 CW (code 3).
    assertEquals(3, mapper.detectScreenshotRotation(1080, 2340, 2340, 1080))
  }

  @Test
  fun `detectScreenshotRotation rotates a landscape screenshot with portrait bounds`() {
    // Landscape image, portrait hierarchy -> 270 CW (code 1).
    assertEquals(1, mapper.detectScreenshotRotation(2340, 1080, 1080, 2340))
  }

  @Test
  fun `detectScreenshotRotation returns zero for non-positive dimensions`() {
    assertEquals(0, mapper.detectScreenshotRotation(0, 2340, 1080, 2340))
    assertEquals(0, mapper.detectScreenshotRotation(1080, 2340, 0, 0))
  }

  @Test
  fun `rotated screenshot maps correctly when device space uses swapped dimensions`() {
    // A landscape device: screenshot arrived portrait (1080x2340) and was rotated to landscape,
    // so the device coordinate space is 2340x1080 and the fitted frame is landscape too.
    val frame = mapper.fitToViewport(2340, 1080, 1200f, 1200f) // landscape frame
    val g =
      geometry(
        frameWidthPx = frame.widthPx,
        frameHeightPx = frame.heightPx,
        deviceWidth = 2340,
        deviceHeight = 1080,
      )
    // Center of the frame maps to the center of the landscape device space.
    val p = mapper.viewportToDevice(ViewportPoint(frame.widthPx / 2f, frame.heightPx / 2f), g)
    assertEquals(1170, p.x)
    assertEquals(540, p.y)
    assertTrue(p.inBounds)
  }

  // ---- Rounding -------------------------------------------------------------

  @Test
  fun `viewportToDevice rounds to nearest integer with halves up`() {
    // frameToDevice = 1080/540 = 2. A viewport x of 0.25 -> device 0.5 -> rounds to 1 (half up).
    val p = mapper.viewportToDevice(ViewportPoint(0.25f, 0f), geometry())
    assertEquals(1, p.x)
  }

  // ---- Out of bounds --------------------------------------------------------

  @Test
  fun `viewportToDevice flags points past the right and bottom edges`() {
    val g = geometry()
    // deviceWidth is exclusive: exactly at width is out of bounds.
    val atWidth = mapper.viewportToDevice(ViewportPoint(540f, 585f), g) // device x = 1080
    assertEquals(1080, atWidth.x)
    assertFalse(atWidth.inBounds)

    val past = mapper.viewportToDevice(ViewportPoint(1000f, 2000f), g)
    assertFalse(past.inBounds)
  }

  @Test
  fun `viewportToDevice flags negative points and does not clamp`() {
    val p = mapper.viewportToDevice(ViewportPoint(-10f, -10f), geometry())
    assertTrue(p.x < 0)
    assertTrue(p.y < 0)
    assertFalse(p.inBounds)
  }

  @Test
  fun `clampedTo pins an out-of-bounds point to the last addressable pixel`() {
    val p = mapper.viewportToDevice(ViewportPoint(1000f, 2000f), geometry()).clampedTo(1080, 2340)
    assertEquals(1079, p.x)
    assertEquals(2339, p.y)
  }

  @Test
  fun `clampedTo marks the clamped point in bounds`() {
    // After clamping into a non-empty screen rect the point is, by definition, inside it, so the
    // stale inBounds=false must flip to true — otherwise a caller clamps then still discards.
    assertEquals(
      DevicePoint(99, 99, inBounds = true),
      DevicePoint(200, 200, false).clampedTo(100, 100),
    )
  }

  @Test
  fun `clampedTo stays out of bounds for a zero-dimension screen`() {
    // A zero-dimension screen has no addressable pixel, so inBounds stays false. The zero axis
    // clamps to 0; the non-zero axis is still clamped to its own last pixel.
    assertEquals(DevicePoint(0, 5, inBounds = false), DevicePoint(5, 5, false).clampedTo(0, 100))
    assertEquals(DevicePoint(5, 0, inBounds = false), DevicePoint(5, 5, false).clampedTo(100, 0))
  }

  // ---- Round trip -----------------------------------------------------------

  @Test
  fun `deviceToViewport is the inverse of viewportToDevice`() {
    val g = geometry(scale = 1.7f, offsetX = 42f, offsetY = 90f)
    val original = ViewportPoint(321f, 654f)
    val device = mapper.viewportToDevice(original, g)
    val back = mapper.deviceToViewport(device.x, device.y, g)
    // Within one device-pixel of viewport error (rounding). One device pixel spans
    // frameWidthPx/deviceWidth frame pixels, i.e. scale * frameWidthPx/deviceWidth viewport pixels.
    val oneDevicePixelInViewport = g.scale * (g.frameWidthPx / g.deviceWidth)
    assertTrue(abs(back.x - original.x) <= oneDevicePixelInViewport)
    assertTrue(abs(back.y - original.y) <= oneDevicePixelInViewport)
  }

  // ---- Inspector selection regression --------------------------------------

  @Test
  fun `inspector hit-test path still resolves the deepest element under a click`() {
    // Reproduces the inspector click path: viewport click -> device coords -> findElementAt.
    val child =
      UIElementInfo(
        id = "child",
        className = "android.widget.Button",
        resourceId = null,
        text = "OK",
        contentDescription = null,
        bounds = ElementBounds(400, 1000, 700, 1200),
        isClickable = true,
        isEnabled = true,
        isFocused = false,
        isSelected = false,
        isScrollable = false,
        isCheckable = false,
        isChecked = false,
        children = emptyList(),
        depth = 1,
      )
    val root =
      UIElementInfo(
        id = "root",
        className = "android.widget.FrameLayout",
        resourceId = null,
        text = null,
        contentDescription = null,
        bounds = ElementBounds(0, 0, 1080, 2340),
        isClickable = false,
        isEnabled = true,
        isFocused = false,
        isSelected = false,
        isScrollable = false,
        isCheckable = false,
        isChecked = false,
        children = listOf(child),
        depth = 0,
      )

    // Frame is half device size; click at frame (275, 550) -> device (550, 1100), inside child.
    val device = mapper.viewportToDevice(ViewportPoint(275f, 550f), geometry())
    val hit = LayoutInspectorMockData.findElementAt(root, device.x, device.y)
    assertNotNull(hit)
    assertEquals("child", hit.id)
  }

  @Test
  fun `inspector hit-test outside the device screen resolves to no element`() {
    val root =
      UIElementInfo(
        id = "root",
        className = "android.widget.FrameLayout",
        resourceId = null,
        text = null,
        contentDescription = null,
        bounds = ElementBounds(0, 0, 1080, 2340),
        isClickable = false,
        isEnabled = true,
        isFocused = false,
        isSelected = false,
        isScrollable = false,
        isCheckable = false,
        isChecked = false,
        children = emptyList(),
        depth = 0,
      )
    // A click above/left of the frame maps to negative device coords -> no element (deselect).
    val device = mapper.viewportToDevice(ViewportPoint(-5f, -5f), geometry())
    assertFalse(device.inBounds)
    assertEquals(null, LayoutInspectorMockData.findElementAt(root, device.x, device.y))
  }
}
