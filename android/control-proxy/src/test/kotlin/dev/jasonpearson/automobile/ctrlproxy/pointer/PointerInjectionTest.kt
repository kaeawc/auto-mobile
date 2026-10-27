package dev.jasonpearson.automobile.ctrlproxy.pointer

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun hover(vararg points: PointerWaypoint, tool: PointerTool = PointerTool.STYLUS) =
  PointerInjectionRequest(tool, hover = true, points = points.toList())

private fun stroke(vararg points: PointerWaypoint, buttons: Int = 0) =
  PointerInjectionRequest(
    PointerTool.STYLUS,
    hover = false,
    points = points.toList(),
    buttons = buttons,
  )

class PointerInjectionPlannerTest {
  @Test
  fun `a hover enters at the first point, moves along the path and exits at the last`() {
    val events =
      PointerInjectionPlanner.plan(
        hover(PointerWaypoint(0f, 0f), PointerWaypoint(32f, 64f, durationMs = 32)),
      )
    assertEquals(
      listOf(
        PointerAction.HOVER_ENTER,
        PointerAction.HOVER_MOVE,
        PointerAction.HOVER_MOVE,
        PointerAction.HOVER_EXIT,
      ),
      events.map { it.action },
    )
    assertEquals(listOf(0L, 16L, 32L, 32L), events.map { it.atMs })
    assertEquals(listOf(0f, 16f, 32f, 32f), events.map { it.x })
    assertEquals(listOf(0f, 32f, 64f, 64f), events.map { it.y })
  }

  @Test
  fun `a single hover point is an enter and an exit at once`() {
    val events = PointerInjectionPlanner.plan(hover(PointerWaypoint(5f, 6f)))
    assertEquals(
      listOf(PointerAction.HOVER_ENTER, PointerAction.HOVER_EXIT),
      events.map { it.action },
    )
    assertEquals(listOf(0L, 0L), events.map { it.atMs })
  }

  @Test
  fun `hover carries no pressure and interpolates distance`() {
    val events =
      PointerInjectionPlanner.plan(
        hover(
          PointerWaypoint(0f, 0f, distance = 1f),
          PointerWaypoint(10f, 0f, durationMs = 32, distance = 0f),
        ),
      )
    assertTrue(events.all { it.pressure == 0f })
    assertEquals(listOf(1f, 0.5f, 0f, 0f), events.map { it.distance })
  }

  @Test
  fun `a stroke goes down, moves with interpolated pressure and lifts at the end pressure`() {
    val events =
      PointerInjectionPlanner.plan(
        stroke(
          PointerWaypoint(0f, 0f, pressure = 0.2f),
          PointerWaypoint(100f, 0f, durationMs = 64, pressure = 1f),
        ),
      )
    assertEquals(PointerAction.DOWN, events.first().action)
    assertEquals(PointerAction.UP, events.last().action)
    assertEquals(
      listOf(0.2f, 0.4f, 0.6f, 0.8f, 1f, 1f),
      events.map { Math.round(it.pressure * 10) / 10f },
    )
    assertEquals(64L, events.last().atMs)
  }

  @Test
  fun `a stroke defaults to full pressure and holds the buttons through the stroke`() {
    val events =
      PointerInjectionPlanner.plan(
        stroke(PointerWaypoint(0f, 0f), PointerWaypoint(1f, 1f, durationMs = 10), buttons = 32),
      )
    assertTrue(events.all { it.pressure == 1f && it.buttons == 32 })
  }

  @Test
  fun `tilt and orientation interpolate too`() {
    val events =
      PointerInjectionPlanner.plan(
        stroke(
          PointerWaypoint(0f, 0f, tilt = 0f, orientation = 0f),
          PointerWaypoint(1f, 1f, durationMs = 32, tilt = 1f, orientation = -1f),
        ),
      )
    assertEquals(1f, events.last().tilt, 0.0001f)
    assertEquals(-1f, events.last().orientation, 0.0001f)
    assertEquals(0.5f, events[1].tilt, 0.0001f)
  }

  @Test
  fun `a zero-length segment still produces one move`() {
    val events =
      PointerInjectionPlanner.plan(hover(PointerWaypoint(0f, 0f), PointerWaypoint(9f, 9f)))
    assertEquals(3, events.size)
    assertEquals(9f, events[1].x)
  }
}

class PointerInjectionValidationTest {
  private fun reason(request: PointerInjectionRequest) = PointerInjectionPlanner.validate(request)

  @Test
  fun `valid requests have no reason`() {
    assertNull(reason(hover(PointerWaypoint(1f, 1f))))
    assertNull(reason(hover(PointerWaypoint(1f, 1f), tool = PointerTool.MOUSE)))
    assertNull(reason(stroke(PointerWaypoint(1f, 1f, pressure = 0.5f))))
  }

  @Test
  fun `a mouse can only hover and has no distance`() {
    assertNotNull(
      reason(PointerInjectionRequest(PointerTool.MOUSE, false, listOf(PointerWaypoint(1f, 1f)))),
    )
    assertNotNull(
      reason(hover(PointerWaypoint(1f, 1f, distance = 0.2f), tool = PointerTool.MOUSE)),
    )
  }

  @Test
  fun `hover has no pressure and no held buttons`() {
    assertEquals("hover has no pressure", reason(hover(PointerWaypoint(1f, 1f, pressure = 0.5f))))
    assertNotNull(
      reason(
        PointerInjectionRequest(
          PointerTool.STYLUS,
          true,
          listOf(PointerWaypoint(1f, 1f)),
          buttons = 32,
        ),
      ),
    )
  }

  @Test
  fun `out-of-range values name the offending point`() {
    assertEquals(
      "points[1]: pressure must be 0 to 1",
      reason(stroke(PointerWaypoint(0f, 0f), PointerWaypoint(1f, 1f, pressure = 1.5f))),
    )
    assertEquals(
      "points[0]: distance must be 0 to 1",
      reason(hover(PointerWaypoint(0f, 0f, distance = -0.1f))),
    )
    assertEquals(
      "points[0]: x and y must be finite and non-negative",
      reason(hover(PointerWaypoint(Float.NaN, 0f))),
    )
    assertNotNull(reason(stroke(PointerWaypoint(0f, 0f, tilt = 2f))))
    assertNotNull(reason(stroke(PointerWaypoint(0f, 0f, orientation = 4f))))
    assertNotNull(
      reason(hover(PointerWaypoint(0f, 0f), PointerWaypoint(1f, 1f, durationMs = 5001))),
    )
  }

  @Test
  fun `size and duration limits and a non-default display are refused`() {
    assertNotNull(reason(hover()))
    assertNotNull(reason(hover(*Array(101) { PointerWaypoint(1f, 1f) })))
    assertNotNull(
      reason(hover(*Array(7) { PointerWaypoint(1f, 1f, durationMs = 4000) })),
    )
    assertTrue(
      reason(
          PointerInjectionRequest(
            PointerTool.STYLUS,
            true,
            listOf(PointerWaypoint(1f, 1f)),
            displayId = 2,
          ),
        )!!
        .contains("display 2"),
    )
  }
}

class PointerRequestCodecTest {
  private fun token(json: String) = Base64.getEncoder().encodeToString(json.toByteArray())

  @Test
  fun `decodes a hover request`() {
    val parsed =
      PointerRequestCodec.decodeBase64(
        token(
          """{"version":1,"tool":"stylus","hover":true,"points":[{"x":10,"y":20.5,"durationMs":120,"distance":0.4},{"x":30,"y":40,"durationMs":50}]}""",
        ),
      ) as PointerRequestParse.Parsed
    val request = parsed.request
    assertEquals(PointerTool.STYLUS, request.tool)
    assertTrue(request.hover)
    assertEquals(PointerWaypoint(10f, 20.5f, 120, distance = 0.4f), request.points[0])
    assertEquals(50L, request.points[1].durationMs)
  }

  @Test
  fun `a stroke request carries pressure and buttons`() {
    val parsed =
      PointerRequestCodec.decode(
        """{"version":1,"tool":"stylus","hover":false,"buttons":32,"points":[{"x":1,"y":2,"pressure":0.3},{"x":3,"y":4,"durationMs":40,"pressure":0.9}]}""",
      ) as PointerRequestParse.Parsed
    assertEquals(32, parsed.request.buttons)
    assertEquals(0.9f, parsed.request.points[1].pressure)
  }

  @Test
  fun `rejects what it cannot trust`() {
    for (bad in
      listOf(
        null,
        "",
        "!!!not-base64!!!",
        token("not json"),
        token("[]"),
        token("""{"version":2,"tool":"stylus","points":[{"x":1,"y":1}]}"""),
        token("""{"version":1,"tool":"finger","points":[{"x":1,"y":1}]}"""),
        token("""{"version":1,"tool":"stylus","points":"x"}"""),
        token("""{"version":1,"tool":"stylus","points":[{"x":"a","y":1}]}"""),
        token("""{"version":1,"tool":"stylus","points":[]}"""),
        token("""{"version":1,"tool":"mouse","hover":false,"points":[{"x":1,"y":1}]}"""),
      )) {
      assertTrue("$bad", PointerRequestCodec.decodeBase64(bad) is PointerRequestParse.Rejected)
    }
  }
}

class PointerInjectionExecutorTest {
  private class Harness(refuseAtIndex: Int? = null) {
    var now = 1000L
    val slept = mutableListOf<Long>()
    val injected = mutableListOf<PlannedPointerEvent>()
    private var count = 0
    var cancelled = false
    val sink = PointerEventSink { event, _ ->
      val index = count++
      if (index == refuseAtIndex) false else injected.add(event)
    }
    val executor =
      PointerInjectionExecutor(
        sink,
        { ms ->
          slept += ms
          now += ms
        },
        { now },
        { cancelled },
      )
  }

  @Test
  fun `plays every event in order, sleeping to each offset`() {
    val h = Harness()
    val result =
      h.executor.run(hover(PointerWaypoint(0f, 0f), PointerWaypoint(10f, 0f, durationMs = 32)))
    assertTrue(result.success)
    assertEquals(4, result.injected)
    assertEquals(listOf(16L, 16L), h.slept)
    assertEquals(32L, result.elapsedMs)
    assertEquals(PointerAction.HOVER_EXIT, h.injected.last().action)
  }

  @Test
  fun `an invalid request injects nothing`() {
    val h = Harness()
    val result = h.executor.run(hover())
    assertFalse(result.success)
    assertTrue(h.injected.isEmpty())
  }

  @Test
  fun `a refused event closes an open stroke with a cancel`() {
    val h = Harness(refuseAtIndex = 2)
    val result =
      h.executor.run(
        stroke(PointerWaypoint(0f, 0f), PointerWaypoint(10f, 0f, durationMs = 64)),
      )
    assertFalse(result.success)
    assertEquals(2, result.injected)
    assertTrue(result.error!!.contains("refused MOVE"))
    assertEquals(PointerAction.CANCEL, h.injected.last().action)
  }

  @Test
  fun `a refused hover event closes the hover with an exit`() {
    val h = Harness(refuseAtIndex = 1)
    val result =
      h.executor.run(hover(PointerWaypoint(0f, 0f), PointerWaypoint(10f, 0f, durationMs = 32)))
    assertFalse(result.success)
    assertEquals(PointerAction.HOVER_EXIT, h.injected.last().action)
  }

  @Test
  fun `a refused first event has nothing to close`() {
    val h = Harness(refuseAtIndex = 0)
    val result = h.executor.run(hover(PointerWaypoint(0f, 0f)))
    assertFalse(result.success)
    assertTrue(h.injected.isEmpty())
  }

  @Test
  fun `cancellation stops the run and closes the pointer`() {
    val h = Harness()
    val request = stroke(PointerWaypoint(0f, 0f), PointerWaypoint(10f, 0f, durationMs = 64))
    val cancelAfterFirst =
      PointerInjectionExecutor(
        { event, _ ->
          h.injected += event
          h.cancelled = true
          true
        },
        {},
        { h.now },
        { h.cancelled },
      )
    val result = cancelAfterFirst.run(request)
    assertFalse(result.success)
    assertEquals("injection was cancelled", result.error)
    assertEquals(PointerAction.CANCEL, h.injected.last().action)
  }

  @Test
  fun `a close that is also refused is reported`() {
    var calls = 0
    val result =
      PointerInjectionExecutor({ _, _ -> ++calls == 1 }, {}, { 0L })
        .run(hover(PointerWaypoint(0f, 0f), PointerWaypoint(5f, 5f, durationMs = 10)))
    assertFalse(result.success)
    assertTrue(result.error!!.contains("could not be closed"))
  }
}

class PointerInjectionSupportTest {
  @Test
  fun `advertised only where am instrument has --no-restart`() {
    assertFalse(PointerInjectionSupport.advertised(32))
    assertTrue(PointerInjectionSupport.advertised(33))
    assertTrue(PointerInjectionSupport.advertised(36))
  }
}

class PointerInjectionButtonsAndMouseTest {
  @Test
  fun `buttons may hold only the stylus barrel buttons`() {
    fun withButtons(buttons: Int) =
      PointerInjectionPlanner.validate(
        PointerInjectionRequest(
          PointerTool.STYLUS,
          hover = false,
          points = listOf(PointerWaypoint(1f, 1f)),
          buttons = buttons,
        ),
      )
    assertNull(withButtons(0))
    assertNull(withButtons(32))
    assertNull(withButtons(32 or 64))
    assertNotNull(withButtons(1))
    assertNotNull(withButtons(-1))
  }

  @Test
  fun `a mouse hover reports no hover distance`() {
    val events =
      PointerInjectionPlanner.plan(
        PointerInjectionRequest(
          PointerTool.MOUSE,
          hover = true,
          points = listOf(PointerWaypoint(1f, 1f), PointerWaypoint(2f, 2f, durationMs = 16)),
        ),
      )
    assertTrue(events.all { it.distance == 0f })
  }
}
