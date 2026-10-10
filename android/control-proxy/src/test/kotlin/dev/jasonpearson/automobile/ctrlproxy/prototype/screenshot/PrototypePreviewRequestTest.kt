package dev.jasonpearson.automobile.ctrlproxy.overlay.screenshot

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OverlayPreviewRequestTest {

  private fun parse(vararg pairs: Pair<String, String>): OverlayPreviewRequest? {
    val map = mapOf(*pairs)
    return OverlayPreviewRequest.fromProperties(map::get, pathSeparator = ":")
  }

  @Test
  fun `no spec property means no preview`() {
    assertNull(parse())
    assertNull(parse(OverlayPreviewRequest.SPEC_PROPERTY to " : "))
  }

  @Test
  fun `defaults to a 360x640 dp light mdpi surface`() {
    val request =
      parse(
        OverlayPreviewRequest.SPEC_PROPERTY to "/specs/a.json",
        OverlayPreviewRequest.OUT_PROPERTY to "/out",
      )!!
    assertEquals(listOf(File("/specs/a.json")), request.specs)
    assertEquals("w360dp-h640dp-notnight-160dpi", request.qualifiers)
    assertEquals(File("/out/a.png"), request.outputFor(request.specs.single()))
    assertEquals(File("/out/contact-sheet.png"), request.contactSheet)
  }

  @Test
  fun `size density and theme map to qualifiers`() {
    val request =
      parse(
        OverlayPreviewRequest.SPEC_PROPERTY to "/a.json:/b.json",
        OverlayPreviewRequest.OUT_PROPERTY to "/out",
        OverlayPreviewRequest.WIDTH_PROPERTY to "411",
        OverlayPreviewRequest.HEIGHT_PROPERTY to "891",
        OverlayPreviewRequest.DENSITY_PROPERTY to "420",
        OverlayPreviewRequest.THEME_PROPERTY to "Dark",
      )!!
    assertEquals(2, request.specs.size)
    assertEquals("w411dp-h891dp-night-420dpi", request.qualifiers)
  }

  @Test
  fun `malformed switches name the switch`() {
    val base =
      arrayOf(
        OverlayPreviewRequest.SPEC_PROPERTY to "/a.json",
        OverlayPreviewRequest.OUT_PROPERTY to "/out",
      )
    fun message(vararg extra: Pair<String, String>) =
      assertThrows(IllegalArgumentException::class.java) { parse(*base, *extra) }.message!!
    assertTrue(message(OverlayPreviewRequest.WIDTH_PROPERTY to "wide").contains("width"))
    assertTrue(message(OverlayPreviewRequest.HEIGHT_PROPERTY to "0").contains("height"))
    assertTrue(message(OverlayPreviewRequest.DENSITY_PROPERTY to "5000").contains("density"))
    assertTrue(message(OverlayPreviewRequest.THEME_PROPERTY to "sepia").contains("theme"))
    val noOut =
      assertThrows(IllegalArgumentException::class.java) {
        parse(OverlayPreviewRequest.SPEC_PROPERTY to "/a.json")
      }
    assertTrue(noOut.message!!.contains(OverlayPreviewRequest.OUT_PROPERTY))
  }

  @Test
  fun `specs that share a file name are rejected`() {
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        parse(
          OverlayPreviewRequest.SPEC_PROPERTY to "/x/a.json:/y/a.json",
          OverlayPreviewRequest.OUT_PROPERTY to "/out",
        )
      }
    assertTrue(error.message!!.contains("a.png"))
  }

  @Test
  fun `contact sheet lays images out in a near-square grid`() {
    val bg = 0
    fun solid(width: Int, height: Int, color: Int) =
      OverlayScreenshotComparator.Image(width, height, IntArray(width * height) { color })
    val sheet =
      overlayContactSheet(
        listOf(solid(2, 2, 1), solid(2, 1, 2), solid(1, 2, 3)),
        gutter = 1,
        background = bg,
      )
    // Three images → 2 columns x 2 rows of 2x2 cells, framed and separated by 1px.
    assertEquals(7, sheet.width)
    assertEquals(7, sheet.height)
    val expected =
      intArrayOf(
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        1,
        0,
        2,
        2,
        0,
        0,
        1,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        3,
        0,
        0,
        0,
        0,
        0,
        0,
        3,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      )
    assertArrayEquals(expected, sheet.pixels)
  }

  @Test
  fun `contact sheet of one image only frames it`() {
    val sheet =
      overlayContactSheet(
        listOf(OverlayScreenshotComparator.Image(1, 1, intArrayOf(5))),
        gutter = 2,
        background = 0,
      )
    assertEquals(5, sheet.width)
    assertEquals(5, sheet.height)
    assertEquals(5, sheet.pixels[2 * 5 + 2])
  }
}
