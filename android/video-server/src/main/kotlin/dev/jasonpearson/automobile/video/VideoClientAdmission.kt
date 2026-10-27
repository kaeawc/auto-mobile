package dev.jasonpearson.automobile.video

import dev.jasonpearson.automobile.video.VideoStreamWriter.Companion.ACCEPT_RATE_WINDOW_MS
import dev.jasonpearson.automobile.video.VideoStreamWriter.Companion.ALLOWED_PEER_UIDS
import dev.jasonpearson.automobile.video.VideoStreamWriter.Companion.HANDSHAKE_READ_TIMEOUT_MS
import dev.jasonpearson.automobile.video.VideoStreamWriter.Companion.MAX_ACCEPTS_PER_RATE_WINDOW
import java.io.IOException

internal class VideoClientAdmission(
  private val socketName: String,
  private val expectedToken: String?,
  private val nowMs: () -> Long,
) {
  private val rateLimiter =
    ConnectionRateLimiter(nowMs, MAX_ACCEPTS_PER_RATE_WINDOW, ACCEPT_RATE_WINDOW_MS)

  fun accepts(client: VideoClientConnection): Boolean {
    val peerUid = client.peerUid
    if (peerUid !in ALLOWED_PEER_UIDS) {
      println(
        "VIDEO_CLIENT_REJECTED socket=$socketName uid=$peerUid not in allowed set $ALLOWED_PEER_UIDS; disconnecting",
      )
      closeRejected(client)
      return false
    }
    if (!rateLimiter.tryAdmit()) {
      println(
        "VIDEO_CLIENT_RATE_LIMITED socket=$socketName exceeded $MAX_ACCEPTS_PER_RATE_WINDOW accepts/${ACCEPT_RATE_WINDOW_MS}ms; disconnecting",
      )
      closeRejected(client)
      return false
    }
    if (!handshakeAccepted(client)) {
      closeRejected(client)
      return false
    }
    return true
  }

  private fun handshakeAccepted(client: VideoClientConnection): Boolean {
    val token = expectedToken ?: return true
    return when (
      val result = VideoHandshake.read(client, token, HANDSHAKE_READ_TIMEOUT_MS, nowMs)
    ) {
      is VideoHandshake.Result.Accepted -> true
      is VideoHandshake.Result.Rejected -> {
        println(
          "VIDEO_CLIENT_HANDSHAKE_REJECTED socket=$socketName reason=${result.reason}; disconnecting",
        )
        false
      }
    }
  }

  private fun closeRejected(client: VideoClientConnection) {
    try {
      client.close()
    } catch (_: IOException) {
      // Best-effort close; a rejected connection never writes or displaces the attached client.
    }
  }
}
