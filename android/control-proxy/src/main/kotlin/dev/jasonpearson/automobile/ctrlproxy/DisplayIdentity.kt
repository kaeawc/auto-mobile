package dev.jasonpearson.automobile.ctrlproxy

import android.view.Display

/** Physical panel ID is not part of the public Display SDK on every supported API. */
internal fun panelUniqueIdOf(display: Display?): String? = display?.let { panel ->
  runCatching {
    panel.javaClass.getMethod("getUniqueId").invoke(panel) as? String
  }
    .getOrNull()
}
