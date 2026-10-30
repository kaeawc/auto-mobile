package dev.jasonpearson.automobile.ctrlproxy.pointer

import android.app.UiAutomation
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent

/**
 * Builds a real `MotionEvent` per planned event and injects it through [UiAutomation], which runs
 * with shell identity. Device-unverified (#13097, #13082): tool type, pressure and hover delivery
 * to apps are what the probe plan settles.
 */
internal class UiAutomationPointerSink(
  private val uiAutomation: UiAutomation,
  private val tool: PointerTool,
  private val eventTimeBase: () -> Long = SystemClock::uptimeMillis,
) : PointerEventSink {
  override fun inject(event: PlannedPointerEvent, downTimeMs: Long): Boolean {
    val properties =
      MotionEvent.PointerProperties().apply {
        id = 0
        toolType =
          if (tool == PointerTool.STYLUS) MotionEvent.TOOL_TYPE_STYLUS
          else MotionEvent.TOOL_TYPE_MOUSE
      }
    val coords =
      MotionEvent.PointerCoords().apply {
        x = event.x
        y = event.y
        pressure = event.pressure
        size = 1f
        setAxisValue(MotionEvent.AXIS_DISTANCE, event.distance)
        setAxisValue(MotionEvent.AXIS_TILT, event.tilt)
        setAxisValue(MotionEvent.AXIS_ORIENTATION, event.orientation)
      }
    val source =
      if (tool == PointerTool.STYLUS) InputDevice.SOURCE_STYLUS else InputDevice.SOURCE_MOUSE
    val now = eventTimeBase()
    val motion =
      MotionEvent.obtain(
        downTimeMs,
        now,
        androidAction(event.action),
        1,
        arrayOf(properties),
        arrayOf(coords),
        0,
        event.buttons,
        1f,
        1f,
        0,
        0,
        source,
        0,
      )
    return try {
      uiAutomation.injectInputEvent(motion, true)
    } finally {
      motion.recycle()
    }
  }

  private fun androidAction(action: PointerAction): Int =
    when (action) {
      PointerAction.HOVER_ENTER -> MotionEvent.ACTION_HOVER_ENTER
      PointerAction.HOVER_MOVE -> MotionEvent.ACTION_HOVER_MOVE
      PointerAction.HOVER_EXIT -> MotionEvent.ACTION_HOVER_EXIT
      PointerAction.DOWN -> MotionEvent.ACTION_DOWN
      PointerAction.MOVE -> MotionEvent.ACTION_MOVE
      PointerAction.UP -> MotionEvent.ACTION_UP
      PointerAction.CANCEL -> MotionEvent.ACTION_CANCEL
    }
}
