package dev.jasonpearson.automobile.junit

import java.util.Locale

private const val BYTES_PER_MEBIBYTE = 1024.0 * 1024.0

internal fun formatMebibytes(bytes: Long, showNegative: Boolean = false): String {
  if (bytes < 0 && !showNegative) {
    return "unknown"
  }

  return String.format(Locale.ROOT, "%.2f MiB", bytes / BYTES_PER_MEBIBYTE)
}
