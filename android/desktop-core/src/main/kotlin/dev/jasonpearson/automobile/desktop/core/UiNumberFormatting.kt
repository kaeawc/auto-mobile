package dev.jasonpearson.automobile.desktop.core

import java.util.Locale

// User-facing text follows the user's locale.
internal fun formatUiNumber(format: String, vararg values: Any): String =
  String.format(Locale.getDefault(), format, *values)
