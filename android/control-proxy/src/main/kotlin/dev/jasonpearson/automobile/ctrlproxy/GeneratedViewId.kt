package dev.jasonpearson.automobile.ctrlproxy

import java.security.MessageDigest

/**
 * Generate a deterministic UUID from a hierarchy path string. Uses SHA-256 to hash the path and
 * formats the first 16 bytes as a UUID string.
 *
 * NOTE (#3228): this id is *positional* — a list scroll shifts child indices, so a moved row gets a
 * different UUID and the row now occupying its old slot inherits the departed row's. The daemon's
 * TS ingest (`StableNodeIdentity.assignStableViewIds`) therefore rewrites every UUID-shaped viewId
 * into a content-derived stable id before the hierarchy reaches consumers. Keep the UUID shape here
 * (8-4-4-4-12 lowercase hex): it is the marker the ingest matches; emitting a different shape would
 * make ids pass through unrewritten.
 */
internal object GeneratedViewId {
  private val digests =
    object : ThreadLocal<MessageDigest>() {
      override fun initialValue(): MessageDigest = MessageDigest.getInstance("SHA-256")
    }

  // Output offsets of the 8-4-4-4-12 group separators.
  private val DASH_OFFSETS = intArrayOf(8, 13, 18, 23)

  fun fromPath(path: String): String {
    // digest(input) resets the thread's digest after computing the hash.
    val bytes = digests.get()!!.digest(path.toByteArray())
    val chars = CharArray(36)
    var offset = 0
    for (index in 0 until 16) {
      if (offset in DASH_OFFSETS) {
        chars[offset++] = '-'
      }
      appendHexByte(bytes[index], chars, offset)
      offset += 2
    }
    return String(chars)
  }
}
