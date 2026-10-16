package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.ctrlproxy.formatHexByte
import java.security.MessageDigest

/**
 * The readable half of an on-disk name for a prototype id: lowercase alphanumerics joined by `-`,
 * at most 32 characters. Saved prototypes and prototype storage both name their files with it,
 * followed by a hash of the whole id, so distinct ids never share a name.
 */
internal fun prototypeIdSlugPrefix(id: String): String =
  id.lowercase(java.util.Locale.ROOT).replace(Regex("[^a-z0-9]+"), "-").trim('-').take(32).ifEmpty {
    "prototype"
  }

internal fun sha256Hex(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { formatHexByte(it) }
