package dev.jasonpearson.automobile.video

import java.security.MessageDigest

/**
 * Pre-stream token handshake for the video-server LocalSocket (issue #4729).
 *
 * The abstract socket name no longer embeds the session token (the host now names the socket with
 * an opaque random id), which closes the `/proc/net/unix` disclosure. To retain a per-connection
 * secret the client must present the session token as the very first bytes after connect, before
 * the server emits any stream header or frame. The server reads it with a bounded deadline,
 * compares in constant time, and on any mismatch/timeout closes the connection with zero bytes
 * written.
 *
 * ## Wire frame (client -> server), sent immediately after connect
 *
 * ```
 * offset 0  MAGIC      4 bytes  0x41 0x56 0x4D 0x48  ("AVMH")
 * offset 4  VERSION    1 byte   protocol version (currently 1)
 * offset 5  TOKEN_LEN  1 byte   token length N, 8..80 (uint8)
 * offset 6  TOKEN      N bytes  ASCII session token (matches SAFE_TOKEN)
 * ```
 *
 * Total = [PREFIX_SIZE] + N bytes. The token is length-prefixed rather than fixed-length so the
 * frame stays compact and self-delimiting.
 *
 * ## Version negotiation
 * The primary, out-of-band negotiation happens BEFORE connect: the server advertises
 * `proto=<version>` on its `VIDEO_SESSION_READY` stdout line. A handshake-aware host reads that
 * field and only sends the frame when the device advertises a version it understands; a host
 * talking to a pre-handshake device (no `proto=`) skips the frame and streams without it
 * (defense-in-depth degrades, streaming does not hard-break). The in-band MAGIC + VERSION bytes are
 * the secondary, defensive layer: they let the server distinguish an unsupported-version or
 * malformed handshake from a legitimate one and log an actionable reason instead of silently
 * hanging. A pre-handshake host against a handshake-requiring device sends no frame and is rejected
 * on the bounded timeout — its existing bounded reconnect budget then falls back to screenrecord
 * rather than looping forever.
 */
object VideoHandshake {
  /** Current handshake protocol version advertised via `proto=` and encoded in the frame. */
  const val PROTOCOL_VERSION = 1

  /** "AVMH": AutoMobile Video Media Handshake. */
  val MAGIC = byteArrayOf(0x41, 0x56, 0x4D, 0x48)

  /** Fixed prefix size: MAGIC(4) + VERSION(1) + TOKEN_LEN(1). */
  const val PREFIX_SIZE = 6

  const val MIN_TOKEN_LENGTH = 8
  const val MAX_TOKEN_LENGTH = 80

  sealed interface Result {
    /** A well-formed handshake carrying the expected token arrived. */
    object Accepted : Result

    /** The handshake was absent, malformed, version-skewed, or carried the wrong token. */
    data class Rejected(val reason: String) : Result
  }

  /**
   * Read and validate the client handshake from [connection] within [timeoutMs] total, comparing
   * the presented token against [expectedToken] in constant time. Returns [Result.Accepted] only
   * for a well-formed, correctly-versioned frame carrying the expected token; otherwise
   * [Result.Rejected] with a short machine-parseable reason. Never writes to [connection].
   *
   * [nowMs] supplies the monotonic clock for splitting the deadline across the prefix and token
   * reads so tests can drive it deterministically; the seam's [VideoClientConnection.readFully]
   * enforces the per-read timeout.
   */
  fun read(
    connection: VideoClientConnection,
    expectedToken: String,
    timeoutMs: Long,
    nowMs: () -> Long = System::currentTimeMillis,
  ): Result {
    val deadline = nowMs() + timeoutMs
    val prefix =
      connection.readFully(PREFIX_SIZE, timeoutMs) ?: return Result.Rejected("timeout-or-eof")
    if (!prefix.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) {
      return Result.Rejected("bad-magic")
    }
    val version = prefix[4].toInt() and 0xFF
    if (version != PROTOCOL_VERSION) {
      return Result.Rejected("unsupported-version=$version")
    }
    val tokenLength = prefix[5].toInt() and 0xFF
    if (tokenLength < MIN_TOKEN_LENGTH || tokenLength > MAX_TOKEN_LENGTH) {
      return Result.Rejected("bad-token-length=$tokenLength")
    }
    val remainingMs = (deadline - nowMs()).coerceAtLeast(1)
    val tokenBytes =
      connection.readFully(tokenLength, remainingMs)
        ?: return Result.Rejected("token-timeout-or-eof")
    val token = String(tokenBytes, Charsets.US_ASCII)
    if (!VideoSessionArguments.SAFE_TOKEN.matches(token)) {
      return Result.Rejected("unsafe-token")
    }
    // MessageDigest.isEqual is the JDK's constant-time byte-array compare: it does not
    // short-circuit
    // on the first differing byte (nor, on JDK 17+, leak via a length branch), so a wrong token is
    // not recoverable one byte at a time from response timing.
    if (!MessageDigest.isEqual(expectedToken.toByteArray(Charsets.US_ASCII), tokenBytes)) {
      return Result.Rejected("token-mismatch")
    }
    return Result.Accepted
  }
}
