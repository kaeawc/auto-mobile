package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ContextWrapper
import kotlin.math.PI
import org.junit.Assert.*
import org.junit.Test

class AndroidSensorSourceTest {
  @Test
  fun `construction and unused close need neither a context nor Main`() {
    PrototypeSensorsModule(AndroidSensorSource(ContextWrapper(null))).close()
  }

  @Test
  fun `rotation orientation radians map azimuth pitch and roll to contract degrees`() {
    val degrees = orientationDegrees(floatArrayOf((-PI / 2).toFloat(), (PI / 4).toFloat(), PI.toFloat()))
    assertEquals(-90.0, degrees.getValue("headingDeg"), 0.0001)
    assertEquals(45.0, degrees.getValue("pitchDeg"), 0.0001)
    assertEquals(180.0, degrees.getValue("rollDeg"), 0.0001)
    assertEquals(setOf("pitchDeg", "rollDeg", "headingDeg"), degrees.keys)
    assertTrue(orientationDegrees(FloatArray(3)).values.all { it == 0.0 })
  }

  @Test
  fun `proximity is near only below the sensors maximum range`() {
    assertTrue(proximityNear(0f, 5f))
    assertTrue(proximityNear(4.99f, 5f))
    assertFalse(proximityNear(5f, 5f))
    assertFalse(proximityNear(6f, 5f))
  }
}
