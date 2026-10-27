package dev.jasonpearson.automobile.ctrlproxy.prototype

/**
 * A pager reports its position (`Page 2 of 4`) and a time or date picker its bound [value]
 * (`07:30`, `2026-10-08`); other roles carry no state of their own here.
 */
internal fun prototypeStateDescription(
  role: String,
  page: Int,
  pageCount: Int,
  value: String? = null,
): String? =
  when {
    role == "pager" && pageCount > 0 -> "Page ${page + 1} of $pageCount"
    role == "timePicker" || role == "datePicker" -> value
    else -> null
  }

/** A time picker's bound value as 24-hour `HH:mm`, or a date picker's `YYYY-MM-DD`. */
internal fun prototypePickerValue(node: PrototypeRenderNode): String? =
  when (node.role) {
    "timePicker" -> String.format(java.util.Locale.ROOT, "%02d:%02d", node.hour, node.minute)
    "datePicker" -> node.selectedValue
    else -> null
  }
