package dev.jasonpearson.automobile.junit

import java.util.Locale

internal fun formatHexByte(value: Byte): String = "%02x".format(Locale.ROOT, value)
