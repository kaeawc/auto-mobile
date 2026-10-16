package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** Pure JVM guard for the N-finger layout shared with the iOS runner (issue #12535). */
class MultiFingerGeometryTest {

  @Test
  fun `two fingers keep the legacy first and offset strokes`() {
    val strokes =
      computeMultiFingerStrokes(100.0, 200.0, 100.0, 50.0, offset = 100, fingerCount = 2)
    assertEquals(
      listOf(FingerStroke(100f, 200f, 100f, 50f), FingerStroke(200f, 200f, 200f, 50f)),
      strokes,
    )
  }

  @Test
  fun `each finger count yields that many strokes spaced by the offset`() {
    for (count in MIN_MULTI_FINGER_COUNT..MAX_MULTI_FINGER_COUNT) {
      val strokes =
        computeMultiFingerStrokes(10.0, 20.0, 30.0, 40.0, offset = 25, fingerCount = count)
      assertEquals(count, strokes.size)
      strokes.forEachIndexed { index, stroke ->
        assertEquals(10f + index * 25f, stroke.startX, 0f)
        assertEquals(30f + index * 25f, stroke.endX, 0f)
        assertEquals(20f, stroke.startY, 0f)
        assertEquals(40f, stroke.endY, 0f)
      }
    }
  }

  @Test
  fun `a stationary gesture keeps every finger on its own down point`() {
    val strokes = computeMultiFingerStrokes(5.0, 5.0, 5.0, 5.0, offset = 40, fingerCount = 3)
    assertEquals(listOf(5f, 45f, 85f), strokes.map { it.startX })
    assertEquals(strokes.map { it.startX }, strokes.map { it.endX })
  }

  @Test
  fun `finger count outside 2-5 is rejected`() {
    assertNotNull(multiFingerCountError(1))
    assertNotNull(multiFingerCountError(6))
    assertNotNull(multiFingerCountError(-1))
    for (count in 2..5) assertNull(multiFingerCountError(count))
  }
}
