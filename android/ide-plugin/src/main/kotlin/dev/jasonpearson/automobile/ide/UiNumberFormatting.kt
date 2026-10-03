package dev.jasonpearson.automobile.ide

import java.util.Locale

// User-facing number formatting follows the user's FORMAT locale.
internal fun formatUiNumber(format: String, vararg values: Any): String =
  String.format(Locale.getDefault(Locale.Category.FORMAT), format, *values)
