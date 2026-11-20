package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.*
import org.junit.Test

class PrototypeCaptureModulesTest {
  @Test
  fun `capture modules register only with declared permission and hardware`() {
    for (available in listOf(emptySet(), PrototypeRuntimePermission.entries.toSet())) {
      val camera = FakePlatformModule("camera")
      val recorder = FakePlatformModule("audioRecorder")
      val other = FakePlatformModule("location")
      val kept = PrototypeCaptureModules.retain(listOf(camera, recorder, other)) { it in available }
      val expected = if (available.isEmpty()) listOf(other) else listOf(camera, recorder, other)
      assertEquals(expected, kept)
      assertEquals(available.isEmpty(), camera.closed)
      assertEquals(available.isEmpty(), recorder.closed)
      assertFalse(other.closed)
    }
  }

  @Test
  fun `each capture module follows its own permission`() {
    val camera = FakePlatformModule("camera")
    val recorder = FakePlatformModule("audioRecorder")
    val kept =
      PrototypeCaptureModules.retain(listOf(camera, recorder)) {
        it == PrototypeRuntimePermission.MICROPHONE
      }
    assertEquals(listOf(recorder), kept)
    assertTrue(camera.closed)
  }
}
