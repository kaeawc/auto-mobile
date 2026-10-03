package dev.jasonpearson.automobile.ctrlproxy

import java.util.Locale

internal fun formatHexByte(value: Byte): String = "%02x".format(Locale.ROOT, value)
