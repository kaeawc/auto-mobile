package dev.jasonpearson.automobile.glassesfixture

/** Pure status-string formatting shared by the activity and its unit tests. */
internal object FixtureStatus {
  const val INPUT_NONE = "input: none"

  fun focus(item: String): String = "focus: $item"

  fun click(count: Int, lastItem: String?, longItem: String?): String = buildString {
    append("clicks: $count last: ")
    append(lastItem ?: "none")
    longItem?.let { append(" long: $it") }
  }

  fun key(keyCodeName: String, actionName: String): String = "key $keyCodeName $actionName"

  fun motion(source: Int, actionName: String): String =
    "motion 0x${source.toString(16)} $actionName"
}
