package dev.jasonpearson.automobile.discover.ictrace

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class IcTraceRecorder(
  private val captureText: Boolean = true,
  private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
  private val startedMs = nowMs()
  private val buffer = ArrayDeque<IcTraceEvent>()
  private val mutableEvents = MutableStateFlow<List<IcTraceEvent>>(emptyList())
  val events: StateFlow<List<IcTraceEvent>> = mutableEvents.asStateFlow()
  private var nextSeq = 1

  @Synchronized
  fun record(
    call: String,
    args: String,
    selectionStart: Int,
    selectionEnd: Int,
    composingStart: Int,
    composingEnd: Int,
  ) {
    if (buffer.size == CAPACITY) buffer.removeFirst()
    buffer.addLast(
      IcTraceEvent(
        nextSeq++,
        (nowMs() - startedMs).coerceAtLeast(0),
        call,
        args,
        selectionStart,
        selectionEnd,
        composingStart,
        composingEnd,
      )
    )
    mutableEvents.value = buffer.toList()
  }

  @Synchronized fun snapshot(): List<IcTraceEvent> = buffer.toList()

  @Synchronized
  fun clear() {
    buffer.clear()
    mutableEvents.value = emptyList()
  }

  // Callers must use this for every text-bearing argument before record().
  fun textArg(text: CharSequence?, capture: Boolean = captureText): String =
    if (text == null) "null"
    else if (!capture) "length=${text.length}"
    else
      buildString {
        append('"')
        text.forEach { char ->
          when (char) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (char.code < 0x20) append("\\u%04x".format(char.code)) else append(char)
          }
        }
        append('"')
      }

  private companion object {
    const val CAPACITY = 500
  }
}
