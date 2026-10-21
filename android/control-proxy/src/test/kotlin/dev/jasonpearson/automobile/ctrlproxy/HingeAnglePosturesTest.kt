package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.FoldPosture
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.Kind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HingeAnglePosturesTest {
  @Test
  fun `angles below thirty degrees are closed`() {
    for (angle in listOf(0f, 29.9f)) {
      assertEquals("angle=$angle", emptyList<FoldPosture>(), hingeAnglePostures(angle))
    }
  }

  @Test
  fun `thirty through below one hundred fifty degrees are half opened`() {
    for (angle in listOf(30f, 90f, 149.9f)) {
      assertEquals(
        "angle=$angle",
        listOf(FoldPosture(Kind.HALF_OPENED, isSeparating = true)),
        hingeAnglePostures(angle),
      )
    }
  }

  @Test
  fun `one hundred fifty degrees and above are flat`() {
    for (angle in listOf(150f, 180f, 200f)) {
      assertEquals(
        "angle=$angle",
        listOf(FoldPosture(Kind.FLAT, isSeparating = false)),
        hingeAnglePostures(angle),
      )
    }
  }

  @Test
  fun `invalid angles are ignored`() {
    assertNull(hingeAnglePostures(Float.NaN))
    assertNull(hingeAnglePostures(-1f))
  }
}
