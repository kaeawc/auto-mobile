package dev.jasonpearson.automobile.demos

import java.util.Locale

/** One pointer of a [ProbeEvent], copied out of a MotionEvent so formatting stays pure Kotlin. */
data class ProbePointer(
  val id: Int,
  val toolType: Int,
  val pressure: Float,
  val tilt: Float,
  val orientation: Float,
  val x: Float,
  val y: Float,
)

/** Snapshot of a MotionEvent delivered to the pointer probe. */
data class ProbeEvent(
  /** Which View callback saw the event: "touch", "hover" or "generic". */
  val via: String,
  val action: Int,
  val deviceId: Int,
  val source: Int,
  val buttonState: Int,
  val pointers: List<ProbePointer>,
  /** MotionEvent.eventTime; identifies one hover event seen by both the View and Compose. */
  val eventTimeMs: Long = 0L,
  /** MotionEvent.actionButton: the button a BUTTON_PRESS/BUTTON_RELEASE changed; 0 otherwise. */
  val actionButton: Int = 0,
)

/**
 * Formats [ProbeEvent]s as single-line text. Constants mirror android.view.MotionEvent /
 * InputDevice.
 */
object PointerProbeFormatter {
  private const val ACTION_MASK = 0xff
  private const val ACTION_POINTER_INDEX_MASK = 0xff00
  private const val ACTION_POINTER_INDEX_SHIFT = 8

  private val ACTION_NAMES =
    mapOf(
      0 to "DOWN",
      1 to "UP",
      2 to "MOVE",
      3 to "CANCEL",
      4 to "OUTSIDE",
      5 to "POINTER_DOWN",
      6 to "POINTER_UP",
      7 to "HOVER_MOVE",
      8 to "SCROLL",
      9 to "HOVER_ENTER",
      10 to "HOVER_EXIT",
      11 to "BUTTON_PRESS",
      12 to "BUTTON_RELEASE",
    )

  private val TOOL_TYPE_NAMES =
    mapOf(0 to "UNKNOWN", 1 to "FINGER", 2 to "STYLUS", 3 to "MOUSE", 4 to "ERASER", 5 to "PALM")

  // Full InputDevice.SOURCE_* values; a flag matches when all of its bits are present.
  // BLUETOOTH_STYLUS is 0x8000 | SOURCE_STYLUS (0x4002).
  private val SOURCE_NAMES =
    listOf(
      0x00004002 to "STYLUS",
      0x0000C002 to "BLUETOOTH_STYLUS",
      0x00001002 to "TOUCHSCREEN",
      0x00002002 to "MOUSE",
      0x00020004 to "MOUSE_RELATIVE",
      0x00100008 to "TOUCHPAD",
      0x00010004 to "TRACKBALL",
      0x00200000 to "TOUCH_NAVIGATION",
      0x00000101 to "KEYBOARD",
      0x01000010 to "JOYSTICK",
    )

  private val BUTTON_NAMES =
    listOf(
      1 to "PRIMARY",
      2 to "SECONDARY",
      4 to "TERTIARY",
      8 to "BACK",
      16 to "FORWARD",
      32 to "STYLUS_PRIMARY",
      64 to "STYLUS_SECONDARY",
    )

  fun actionName(action: Int): String {
    val masked = action and ACTION_MASK
    val base = ACTION_NAMES[masked] ?: "ACTION_$masked"
    val index = (action and ACTION_POINTER_INDEX_MASK) shr ACTION_POINTER_INDEX_SHIFT
    return if (masked == 5 || masked == 6) "$base[$index]" else base
  }

  fun toolTypeName(toolType: Int): String = TOOL_TYPE_NAMES[toolType] ?: "TOOL_$toolType"

  /** Names of the source bits present, joined with "|"; falls back to hex when none match. */
  fun sourceNames(source: Int): String {
    val matched = SOURCE_NAMES.filter { (flag, _) -> (source and flag) == flag }.map { it.second }
    return if (matched.isEmpty()) hex(source) else matched.joinToString("|")
  }

  /** Names of the buttons held, joined with "|"; "NONE" when no button is down. */
  fun buttonNames(buttonState: Int): String {
    val matched =
      BUTTON_NAMES.filter { (flag, _) -> (buttonState and flag) == flag }.map { it.second }
    return if (matched.isEmpty()) "NONE" else matched.joinToString("|")
  }

  /** Two decimals, always with a dot regardless of device locale. */
  fun number(value: Float): String = String.format(Locale.US, "%.2f", value)

  /**
   * `#<seq> <via> <ACTION> dev=<id> src=<names>(0x..) btn=<names> p0:<TOOL> pr=.. tilt=.. ori=..`
   *
   * A BUTTON_PRESS/BUTTON_RELEASE also carries ` changed=<name>` after `btn=`, since `btn=` only
   * lists the buttons still held.
   */
  fun format(sequence: Int, event: ProbeEvent): String {
    val pointers =
      event.pointers.joinToString(" ") { pointer ->
        "p${pointer.id}:${toolTypeName(pointer.toolType)} pr=${number(pointer.pressure)} " +
          "tilt=${number(pointer.tilt)} ori=${number(pointer.orientation)} " +
          "xy=${number(pointer.x)},${number(pointer.y)}"
      }
    return "#$sequence ${event.via} ${actionName(event.action)} dev=${event.deviceId} " +
      "src=${sourceNames(event.source)}(${hex(event.source)}) " +
      "btn=${buttonNames(event.buttonState)}(${event.buttonState}) " +
      (if (event.actionButton != 0) "changed=${buttonNames(event.actionButton)} " else "") +
      pointers
  }

  private fun hex(value: Int): String = "0x" + Integer.toHexString(value)
}
