package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.material3.Shapes
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import dev.jasonpearson.automobile.protocol.PrototypeCornerRadius
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeContinuousShapeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmShapes() {
      prototypeContinuousRadii(
        prototypeCornerShape(Shapes(), PrototypeCornerRadius.Token("full")),
        Size(200f, 100f),
        LayoutDirection.Ltr,
        Density(1f),
      )
    }
  }

  @Test
  fun `zero small half and full radii produce finite paths inside rectangular and square bounds`() {
    for (size in listOf(Size(200f, 100f), Size(100f, 100f))) {
      for (radius in listOf(0f, 8f, 50f, 9999f)) {
        val corners = prototypeContinuousCorners(size, List(4) { CornerRadius(radius) })
        val points = corners.flatMap { listOf(it.start, it.first, it.second, it.end) }
        // A Bezier curve is contained in its control polygon, including every interpolated point.
        assertTrue(points.all { it.x.isFinite() && it.y.isFinite() })
        assertTrue(points.all { it.x in 0f..size.width && it.y in 0f..size.height })
        assertEquals(0f, points.minOf { it.x })
        assertEquals(0f, points.minOf { it.y })
        assertEquals(size.width, points.maxOf { it.x })
        assertEquals(size.height, points.maxOf { it.y })
      }
    }
  }

  @Test
  fun `mixed corners resolve RTL then clamp each corner independently`() {
    val size = Size(200f, 100f)
    val radius =
      PrototypeCornerRadius.Corners(
        topStart = 8.0,
        topEnd = 16.0,
        bottomEnd = 9999.0,
        bottomStart = 0.0,
      )
    val shape = prototypeCornerShape(Shapes(), radius)
    for (direction in LayoutDirection.entries) {
      val radii = checkNotNull(prototypeContinuousRadii(shape, size, direction, Density(1f)))
      val expected =
        if (direction == LayoutDirection.Ltr) listOf(8f, 16f, 9999f, 0f)
        else listOf(16f, 8f, 0f, 9999f)
      assertEquals(expected, radii.map { it.x })
      val corners = prototypeContinuousCorners(size, radii)
      assertEquals(Offset(expected.first(), 0f), corners.last().end)
      assertTrue(
        corners
          .flatMap { listOf(it.start, it.first, it.second, it.end) }
          .all { it.x in 0f..200f && it.y in 0f..100f },
      )
    }
  }

  @Test
  fun `full tokens and excessive dp radii produce the same pill or circle geometry`() {
    for (size in listOf(Size(200f, 100f), Size(100f, 100f))) {
      val shapes = Shapes()
      val token =
        checkNotNull(
          prototypeContinuousRadii(
            prototypeCornerShape(shapes, PrototypeCornerRadius.Token("full")),
            size,
            LayoutDirection.Ltr,
            Density(2f),
          ),
        )
      val literal =
        checkNotNull(
          prototypeContinuousRadii(
            prototypeCornerShape(shapes, PrototypeCornerRadius.Dp(9999.0)),
            size,
            LayoutDirection.Ltr,
            Density(2f),
          ),
        )
      assertEquals(
        prototypeContinuousCorners(size, token),
        prototypeContinuousCorners(size, literal),
      )
    }
    assertTrue(
      prototypeContinuousCorners(Size.Zero, List(4) { CornerRadius.Zero }).all {
        it.start == Offset.Zero && it.end == Offset.Zero
      },
    )
  }
}
