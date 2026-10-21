package dev.jasonpearson.automobile.ctrlproxy

private const val HEX_DIGITS = "0123456789abcdef"

internal fun appendHexByte(value: Byte, chars: CharArray, offset: Int) {
  val unsigned = value.toInt() and 0xff
  chars[offset] = HEX_DIGITS[unsigned ushr 4]
  chars[offset + 1] = HEX_DIGITS[unsigned and 0x0f]
}

// Intentionally duplicated in :junit-runner and :control-proxy: neither module may depend on the
// other (JVM runner vs. Android service).
internal fun formatHexByte(value: Byte): String {
  val chars = CharArray(2)
  appendHexByte(value, chars, 0)
  return String(chars)
}
