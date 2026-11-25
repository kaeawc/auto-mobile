package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.DirectoryPrototypeMediaFiles
import dev.jasonpearson.automobile.protocol.PrototypeMediaUploadReceiver
import java.security.MessageDigest
import java.util.Base64
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PrototypeMediaUploadControllerTest {
  private data class Reply(
    val requestId: String?,
    val success: Boolean,
    val error: String?,
    val code: String? = null,
  )

  @get:Rule val folder = TemporaryFolder()

  private val replies = mutableListOf<Reply>()
  private var session = 1
  private val receiver by lazy {
    PrototypeMediaUploadReceiver(
      DirectoryPrototypeMediaFiles(folder.root),
      decodeBase64 = { Base64.getDecoder().decode(it) },
    )
  }
  private val controller by lazy {
    PrototypeMediaUploadController(
      receiver,
      object : PrototypeResultSink {
        override suspend fun send(requestId: String?, success: Boolean, error: String?) {
          replies += Reply(requestId, success, error)
        }

        override suspend fun sendMediaRefusal(requestId: String?, code: String, error: String) {
          replies += Reply(requestId, false, error, code)
        }
      },
      session = { session },
      io = EmptyCoroutineContext,
    )
  }

  private val mp4 = byteArrayOf(0, 0, 0, 0x18) + "ftypisom".toByteArray() + ByteArray(40) { 7 }

  private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private fun encoded(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

  private fun storedFiles(): List<String> = folder.root.list().orEmpty().sorted()

  @Test
  fun `begin, chunks and commit each answer once and store the asset`() = runTest {
    controller.begin("b", "clip", "video/mp4", mp4.size.toLong(), sha256(mp4))
    controller.chunk("c1", "clip", 0, encoded(mp4.copyOfRange(0, 20)))
    controller.chunk("c2", "clip", 20, encoded(mp4.copyOfRange(20, mp4.size)))
    controller.commit("m", "clip")
    assertEquals(
      listOf("b", "c1", "c2", "m").map { Reply(it, success = true, error = null) },
      replies,
    )
    val stored = checkNotNull(receiver.file("clip"))
    assertEquals(mp4.toList(), stored.readBytes().toList())
  }

  @Test
  fun `a refusal carries the rejection code and drops the partial file`() = runTest {
    controller.begin("b", "clip", "video/mp4", mp4.size.toLong(), sha256(mp4))
    controller.chunk("c", "clip", 4, encoded(mp4.copyOfRange(4, 8)))
    assertEquals(
      Reply("c", false, "Chunk offset 4; expected 0.", "offset_mismatch"),
      replies.last(),
    )
    assertEquals(emptyList<String>(), storedFiles())
    controller.commit("m", "clip")
    assertEquals("unknown_upload", replies.last().code)
  }

  @Test
  fun `a mismatched sha256 is refused at commit and leaves no file`() = runTest {
    controller.begin("b", "clip", "video/mp4", mp4.size.toLong(), "0".repeat(64))
    controller.chunk("c", "clip", 0, encoded(mp4))
    controller.commit("m", "clip")
    assertEquals("sha256_mismatch", replies.last().code)
    assertNull(receiver.lookup("clip"))
    assertEquals(emptyList<String>(), storedFiles())
  }

  @Test
  fun `abort is idempotent and always succeeds`() = runTest {
    controller.begin("b", "clip", "video/mp4", mp4.size.toLong(), sha256(mp4))
    controller.abort("a1", "clip")
    controller.abort("a2", "clip")
    assertEquals(listOf(true, true, true), replies.map { it.success })
    assertEquals(emptyList<String>(), storedFiles())
  }

  @Test
  fun `a later observer session drops the earlier session's media first`() = runTest {
    controller.begin("b", "clip", "video/mp4", mp4.size.toLong(), sha256(mp4))
    controller.chunk("c", "clip", 0, encoded(mp4))
    controller.commit("m", "clip")
    session = 2
    controller.commit("again", "other")
    assertNull(receiver.lookup("clip"))
    assertEquals(emptyList<String>(), storedFiles())
  }

  @Test
  fun `clear drops stored media and in-flight uploads`() = runTest {
    controller.begin("b", "clip", "video/mp4", mp4.size.toLong(), sha256(mp4))
    controller.chunk("c", "clip", 0, encoded(mp4))
    controller.commit("m", "clip")
    controller.begin("b2", "next", "video/mp4", mp4.size.toLong(), sha256(mp4))
    controller.clear()
    assertNull(receiver.lookup("clip"))
    assertEquals(emptyList<String>(), storedFiles())
    controller.chunk("c2", "next", 0, encoded(mp4))
    assertEquals("unknown_upload", replies.last().code)
  }
}
