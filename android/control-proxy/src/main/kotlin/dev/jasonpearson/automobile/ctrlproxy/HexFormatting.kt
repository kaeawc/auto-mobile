package dev.jasonpearson.automobile.ctrlproxy

import java.util.Locale

// Intentionally duplicated in :junit-runner and :control-proxy: neither module may depend on the
// other (JVM runner vs. Android service).
internal fun formatHexByte(value: Byte): String = "%02x".format(Locale.ROOT, value)
