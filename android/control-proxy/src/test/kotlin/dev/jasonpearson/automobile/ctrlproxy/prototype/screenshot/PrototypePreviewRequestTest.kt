package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypePreviewRequestTest {

  private fun parse(vararg pairs: Pair<String, String>): PrototypePreviewRequest? {
    val map = mapOf(*pairs)
    return PrototypePreviewRequest.fromProperties(map::get, pathSeparator = ":")
  }

  @Test
  fun `no spec property means no preview`() {
    assertNull(parse())
    assertNull(parse(PrototypePreviewRequest.SPEC_PROPERTY to " : "))
  }

  @Test
  fun `defaults to a 360x640 dp light mdpi surface`() {
    val request =
      parse(
        PrototypePreviewRequest.SPEC_PROPERTY to "/specs/a.json",
        PrototypePreviewRequest.OUT_PROPERTY to "/out",
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
        PrototypePreviewRequest.SPEC_PROPERTY to "/a.json:/b.json",
        PrototypePreviewRequest.OUT_PROPERTY to "/out",
        PrototypePreviewRequest.WIDTH_PROPERTY to "411",
        PrototypePreviewRequest.HEIGHT_PROPERTY to "891",
        PrototypePreviewRequest.DENSITY_PROPERTY to "420",
        PrototypePreviewRequest.THEME_PROPERTY to "Dark",
      )!!
    assertEquals(2, request.specs.size)
    assertEquals("w411dp-h891dp-night-420dpi", request.qualifiers)
  }

  @Test
  fun `malformed switches name the switch`() {
    val base =
      arrayOf(
        PrototypePreviewRequest.SPEC_PROPERTY to "/a.json",
        PrototypePreviewRequest.OUT_PROPERTY to "/out",
      )
    fun message(vararg extra: Pair<String, String>) =
      assertThrows(IllegalArgumentException::class.java) { parse(*base, *extra) }.message!!
    assertTrue(message(PrototypePreviewRequest.WIDTH_PROPERTY to "wide").contains("width"))
    assertTrue(message(PrototypePreviewRequest.HEIGHT_PROPERTY to "0").contains("height"))
    assertTrue(message(PrototypePreviewRequest.DENSITY_PROPERTY to "5000").contains("density"))
    assertTrue(message(PrototypePreviewRequest.THEME_PROPERTY to "sepia").contains("theme"))
    val noOut =
      assertThrows(IllegalArgumentException::class.java) {
        parse(PrototypePreviewRequest.SPEC_PROPERTY to "/a.json")
      }
    assertTrue(noOut.message!!.contains(PrototypePreviewRequest.OUT_PROPERTY))
  }

  @Test
  fun `specs that share a file name are rejected`() {
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        parse(
          PrototypePreviewRequest.SPEC_PROPERTY to "/x/a.json:/y/a.json",
          PrototypePreviewRequest.OUT_PROPERTY to "/out",
        )
      }
    assertTrue(error.message!!.contains("a.png"))
  }

  @Test
  fun `contact sheet lays images out in a near-square grid`() {
    val bg = 0
    fun solid(width: Int, height: Int, color: Int) =
      PrototypeScreenshotComparator.Image(width, height, IntArray(width * height) { color })
    val sheet =
      prototypeContactSheet(
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
      prototypeContactSheet(
        listOf(PrototypeScreenshotComparator.Image(1, 1, intArrayOf(5))),
        gutter = 2,
        background = 0,
      )
    assertEquals(5, sheet.width)
    assertEquals(5, sheet.height)
    assertEquals(5, sheet.pixels[2 * 5 + 2])
  }
}
