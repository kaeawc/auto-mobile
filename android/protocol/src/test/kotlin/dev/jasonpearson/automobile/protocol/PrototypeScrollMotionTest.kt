package dev.jasonpearson.automobile.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class PrototypeScrollMotionTest {
  @Test
  fun `offset interpolation clamps and supports descending output`() {
    val range = listOf(0.0, 160.0)
    val output = listOf(1.0, 0.0)
    assertEquals(1.0, PrototypeScrollMotion.interpolate(-20.0, range, output), 0.00001)
    assertEquals(0.5, PrototypeScrollMotion.interpolate(80.0, range, output), 0.00001)
    assertEquals(0.0, PrototypeScrollMotion.interpolate(200.0, range, output), 0.00001)
    assertEquals(-20.0, PrototypeScrollMotion.interpolate(80.0, range, listOf(0.0, -40.0)), 0.00001)
  }

  @Test
  fun `reduced keeps alpha and drops spatial outputs while motion off keeps all`() {
    val linked =
      PrototypeScrollLinked(
        "feed",
        listOf(0.0, 160.0),
        alpha = listOf(1.0, 0.0),
        scale = listOf(1.0, 0.8),
        offsetY = listOf(0.0, -40.0),
        offsetX = listOf(0.0, 20.0),
        blur = listOf(0.0, 8.0),
      )
    assertEquals(
      PrototypeScrollMotion.Draw(alpha = 0.5),
      PrototypeScrollMotion.draw(linked, 80.0, true),
    )
    assertEquals(
      PrototypeScrollMotion.Draw(0.5, 0.9, 10.0, -20.0, 4.0),
      PrototypeScrollMotion.draw(linked, 80.0, false),
    )
  }

  @Test
  fun `finite extremes do not overflow`() {
    assertEquals(
      0.0,
      PrototypeScrollMotion.interpolate(0.0, listOf(-1e308, 1e308), listOf(-1e308, 1e308)),
      0.0,
    )
  }

  @Test
  fun `edge transitions are symmetric and settle to identity at center`() {
    assertEquals(1.0, PrototypeScrollMotion.edge(0.0, 0.8, 1.0), 0.00001)
    assertEquals(0.9, PrototypeScrollMotion.edge(-0.5, 0.8, 1.0), 0.00001)
    assertEquals(0.8, PrototypeScrollMotion.edge(2.0, 0.8, 1.0), 0.00001)
  }
}
