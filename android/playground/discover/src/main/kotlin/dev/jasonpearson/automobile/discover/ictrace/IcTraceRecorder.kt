package dev.jasonpearson.automobile.discover.ictrace

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class IcTraceRecorder(
  captureText: Boolean = false,
  private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
  private val startedMs = nowMs()
  private val buffer = ArrayDeque<IcTraceEvent>()
  private val mutableEvents = MutableStateFlow<List<IcTraceEvent>>(emptyList())
  val events: StateFlow<List<IcTraceEvent>> = mutableEvents.asStateFlow()
  private var nextSeq = 1
  @Volatile private var includeText = captureText
  private var droppedEvents = 0
  private var metadata = IcTraceMetadata()

  @Synchronized
  fun record(
    call: String,
    args: String,
    selectionStart: Int,
    selectionEnd: Int,
    composingStart: Int,
    composingEnd: Int,
    result: Boolean? = null,
    readValue: String? = null,
  ) {
    if (buffer.size == CAPACITY) {
      buffer.removeFirst()
      droppedEvents++
    }
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
        result,
        readValue,
        droppedEvents,
        metadata,
      )
    )
    mutableEvents.value = buffer.toList()
  }

  @Synchronized fun snapshot(): List<IcTraceEvent> = buffer.toList()

  @Synchronized
  fun updateMetadata(metadata: IcTraceMetadata) {
    this.metadata =
      if (metadata.scenario == "unspecified") metadata.copy(scenario = this.metadata.scenario)
      else metadata
  }

  @Synchronized
  fun updateScenario(scenario: String) {
    metadata = metadata.copy(scenario = scenario.ifBlank { "unspecified" })
  }

  fun setCaptureText(capture: Boolean) {
    includeText = capture
  }

  @Synchronized fun droppedEventCount(): Int = droppedEvents

  @Synchronized
  fun clear() {
    buffer.clear()
    droppedEvents = 0
    mutableEvents.value = emptyList()
  }

  // Callers must use this for every text-bearing argument before record().
  fun textArg(text: CharSequence?, capture: Boolean = includeText): String =
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
            else ->
              if (char.code < 0x20)
                append(String.format(java.util.Locale.ROOT, "\\u%04x", char.code))
              else append(char)
          }
        }
        append('"')
      }

  fun safeText(text: CharSequence?, capture: Boolean = includeText): String? =
    if (text == null) null else if (capture) textArg(text, true) else "length=${text.length}"

  private companion object {
    const val CAPACITY = 500
  }
}
