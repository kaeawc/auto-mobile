package dev.jasonpearson.automobile.video

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoHandshakeTest {
  /**
   * Serves a scripted handshake to [VideoHandshake.read] via [readFully]; a null [bytes] models a
   * silent connector so every read returns null. Never used for output.
   */
  private class FakeConnection(private val bytes: ByteArray?) : VideoClientConnection {
    override val outputStream: OutputStream = ByteArrayOutputStream()
    override val inputStream: InputStream = InputStream.nullInputStream()
    override val peerUid: Int = 2000
    private var offset = 0

    override fun readFully(count: Int, timeoutMs: Long): ByteArray? {
      val source = bytes ?: return null
      if (offset + count > source.size) return null
      val slice = source.copyOfRange(offset, offset + count)
      offset += count
      return slice
    }

    override fun close() {}
  }

  private fun frame(
    token: String,
    version: Int = VideoHandshake.PROTOCOL_VERSION,
    magic: ByteArray = VideoHandshake.MAGIC,
    tokenLengthOverride: Int? = null,
  ): ByteArray {
    val tokenBytes = token.toByteArray(Charsets.US_ASCII)
    val out = ByteArrayOutputStream()
    out.write(magic)
    out.write(version)
    out.write(tokenLengthOverride ?: tokenBytes.size)
    out.write(tokenBytes)
    return out.toByteArray()
  }

  private fun read(
    bytes: ByteArray?,
    expectedToken: String = "session-0001",
  ): VideoHandshake.Result =
    VideoHandshake.read(FakeConnection(bytes), expectedToken, timeoutMs = 2_000L, nowMs = { 0L })

  @Test
  fun acceptsAWellFormedFrameCarryingTheExpectedToken() {
    assertEquals(VideoHandshake.Result.Accepted, read(frame("session-0001")))
  }

  @Test
  fun rejectsAWrongToken() {
    val result = read(frame("session-9999"))
    assertTrue(result is VideoHandshake.Result.Rejected)
    assertEquals("token-mismatch", (result as VideoHandshake.Result.Rejected).reason)
  }

  @Test
  fun rejectsASilentConnector() {
    val result = read(null)
    assertTrue(result is VideoHandshake.Result.Rejected)
    assertEquals("timeout-or-eof", (result as VideoHandshake.Result.Rejected).reason)
  }

  @Test
  fun rejectsBadMagic() {
    val result = read(frame("session-0001", magic = byteArrayOf(0, 0, 0, 0)))
    assertTrue(result is VideoHandshake.Result.Rejected)
    assertEquals("bad-magic", (result as VideoHandshake.Result.Rejected).reason)
  }

  @Test
  fun rejectsAnUnsupportedVersion() {
    val result = read(frame("session-0001", version = 99))
    assertTrue(result is VideoHandshake.Result.Rejected)
    assertEquals("unsupported-version=99", (result as VideoHandshake.Result.Rejected).reason)
  }

  @Test
  fun rejectsAnOutOfRangeTokenLength() {
    // A declared length below the minimum is rejected before any token read.
    val result = read(frame("short", tokenLengthOverride = 5))
    assertTrue(result is VideoHandshake.Result.Rejected)
    assertEquals("bad-token-length=5", (result as VideoHandshake.Result.Rejected).reason)
  }

  @Test
  fun rejectsATruncatedTokenBody() {
    // Prefix declares a longer token than the frame carries: the token read runs short and rejects.
    val result = read(frame("session-0001", tokenLengthOverride = 40))
    assertTrue(result is VideoHandshake.Result.Rejected)
    assertEquals("token-timeout-or-eof", (result as VideoHandshake.Result.Rejected).reason)
  }

  @Test
  fun rejectsAnUnsafeTokenShape() {
    // 8 bytes so the length gate passes, but the space fails SAFE_TOKEN's character class.
    val result = read(frame("bad tok!", tokenLengthOverride = 8), expectedToken = "bad tok!")
    assertTrue(result is VideoHandshake.Result.Rejected)
    assertEquals("unsafe-token", (result as VideoHandshake.Result.Rejected).reason)
  }
}
