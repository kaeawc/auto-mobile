package dev.jasonpearson.automobile.ctrlproxy.ime

/**
 * Text-free IME diagnostics: one key=value line per event, mirrored to logcat and a bounded ring.
 */
internal class ImeTraceRecorder(
  private val capacity: Int = DEFAULT_CAPACITY,
  private val elapsedRealtimeMs: () -> Long,
  private val emit: (String) -> Unit,
) {
  private val lines = ArrayDeque<String>()
  private var sequence = 0L

  @Synchronized
  fun record(event: String, vararg fields: Pair<String, Any?>) {
    // Diagnostics must never interrupt delivery, including a failed clock or logcat emitter.
    runCatching {
      val line = buildString {
        append("seq=${++sequence} t=${elapsedRealtimeMs()} event=${token(event)}")
        for ((key, value) in fields) {
          if (value != null) append(" ${token(key)}=${valueToken(value)}")
        }
      }
      if (capacity > 0) {
        while (lines.size >= capacity) lines.removeFirst()
        lines.addLast(line)
      }
      emit(line)
    }
  }

  @Synchronized fun snapshot(): List<String> = lines.toList()

  private fun token(value: String): String = if (TOKEN.matches(value)) value else "invalid"

  private fun valueToken(value: Any): String =
    when (value) {
      is Number ->
        if (
          value is Byte ||
            value is Short ||
            value is Int ||
            value is Long ||
            value is Float ||
            value is Double
        )
          token(value.toString())
        else "invalid"
      is Boolean -> value.toString()
      is String -> token(value)
      is CharSequence -> token(value.toString())
      else -> "invalid"
    }

  companion object {
    const val TAG = "CtrlProxyImeTrace"
    const val DEFAULT_CAPACITY = 256
    private val TOKEN = Regex("^[A-Za-z0-9_.:-]{1,64}$")
  }
}

internal fun editorTraceFields(
  packageName: String?,
  fieldId: Int,
  inputType: Int,
  imeOptions: Int,
): Array<Pair<String, Any?>> =
  if (ImeCommitDriver.isPasswordInput(inputType)) arrayOf("secure" to true)
  else
    arrayOf(
      "editorPkg" to packageName,
      "fieldId" to fieldId,
      "inputType" to inputType,
      "imeOptions" to imeOptions,
      "secure" to false,
    )

/** Non-function type so the existing grapheme-splitter constructor remains unambiguous. */
interface ImeDriverTrace {
  fun record(event: String, fields: Array<out Pair<String, Any?>>)

  companion object {
    val NONE: ImeDriverTrace =
      object : ImeDriverTrace {
        override fun record(event: String, fields: Array<out Pair<String, Any?>>) = Unit
      }
  }
}
