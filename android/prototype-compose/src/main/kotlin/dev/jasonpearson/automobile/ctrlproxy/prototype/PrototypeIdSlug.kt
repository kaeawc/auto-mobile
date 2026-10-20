package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.security.MessageDigest
import java.util.Locale

/**
 * The readable half of an on-disk name for a prototype id: lowercase alphanumerics joined by `-`,
 * at most 32 characters. Saved prototypes and prototype storage both name their files with it,
 * followed by a hash of the whole id, so distinct ids never share a name.
 */
@InternalAutoMobilePrototypeApi
fun prototypeIdSlugPrefix(id: String): String =
  id.lowercase(java.util.Locale.ROOT).replace(Regex("[^a-z0-9]+"), "-").trim('-').take(32).ifEmpty {
    "prototype"
  }

@InternalAutoMobilePrototypeApi
fun sha256Hex(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") {
    "%02x".format(Locale.ROOT, it)
  }
