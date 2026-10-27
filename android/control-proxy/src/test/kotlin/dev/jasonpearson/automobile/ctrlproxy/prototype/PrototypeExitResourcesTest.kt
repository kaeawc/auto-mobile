package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.*
import org.junit.Test

class PrototypeExitResourcesTest {
  @Test
  fun `cleanup waits for all exits and runs only once`() {
    val resources = PrototypeExitResources()
    val first = Any()
    val second = Any()
    var calls = 0
    resources.retain(first)
    resources.retain(second)
    resources.whenIdle { calls++ }
    resources.release(first)
    assertEquals(0, calls)
    resources.release(second)
    resources.release(second)
    assertEquals(1, calls)
  }

  @Test
  fun `without an outgoing window cleanup is immediate`() {
    var calls = 0
    PrototypeExitResources().whenIdle { calls++ }
    assertEquals(1, calls)
  }

  @Test
  fun `exiting metadata remains nonopaque and motion active until detach`() {
    val resources = PrototypeExitResources()
    val owner = Any()
    resources.retain(owner, surfaceId = "window") {
      PrototypeWindowMetadata("fullscreen", true, motion = PrototypeMotionState.Settled)
    }
    assertEquals(1, resources.count("window"))
    assertNull(resources.metadata("other"))
    assertFalse(resources.metadata("window")!!.opaque)
    assertEquals(1, resources.metadata("window")!!.motion!!.active)
    resources.release(owner)
    assertNull(resources.metadata("window"))
  }

  @Test
  fun `service drain detaches every outgoing window before asset cleanup`() {
    val resources = PrototypeExitResources()
    val history = mutableListOf<String>()
    resources.retain(Any(), { history += "first" })
    resources.retain(Any(), { history += "second" })
    resources.whenIdle { history += "assets" }
    resources.drain()
    resources.drain()
    assertEquals(listOf("first", "second", "assets"), history)
    assertEquals(0, resources.count(null))
  }
}
