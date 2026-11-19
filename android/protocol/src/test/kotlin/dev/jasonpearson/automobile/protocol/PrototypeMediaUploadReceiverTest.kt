package dev.jasonpearson.automobile.protocol

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Base64
import java.util.HexFormat
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/** In-memory [PrototypeMediaFiles] that records partial and committed files by name. */
private class FakeMediaFiles(private val failAppend: Boolean = false) : PrototypeMediaFiles {
  val partials = mutableMapOf<String, java.io.ByteArrayOutputStream>()
  val committed = mutableMapOf<String, ByteArray>()

  override fun create(name: String): PrototypeMediaPartialFile {
    val buffer = java.io.ByteArrayOutputStream()
    partials[name] = buffer
    return object : PrototypeMediaPartialFile {
      override fun append(bytes: ByteArray) {
        if (failAppend) throw IOException("disk full")
        buffer.write(bytes)
      }

      override fun publish() {
        committed[name] = buffer.toByteArray()
        partials.remove(name)
      }

      override fun discard() {
        partials.remove(name)
      }
    }
  }

  override fun delete(name: String) {
    committed.remove(name)
  }
}

private var nextName = 0

/** A receiver with JVM base64 and a unique file name per upload unless a test pins names. */
private fun newReceiver(
  files: PrototypeMediaFiles,
  limits: PrototypeMediaLimits = PrototypeMediaLimits(),
  newName: () -> String = { "n${nextName++}" },
) = PrototypeMediaUploadReceiver(files, limits, newName, Base64.getDecoder()::decode)

private object MediaCases {
  val root: JsonObject by lazy {
    val fixture =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype-media-transport/cases.json") }
        .first { it.isFile }
    Json.parseToJsonElement(fixture.readText()).jsonObject
  }

  fun list(key: String) = root.getValue(key).jsonArray.map { it.jsonObject }
}

private fun JsonObject.text(key: String): String? = get(key)?.jsonPrimitive?.contentOrNull

private fun hex(value: String): ByteArray =
  value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

private fun sha256(bytes: ByteArray): String =
  HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))

private fun rejection(result: PrototypeMediaResult): String? =
  (result as? PrototypeMediaResult.Rejected)?.reason?.code

class PrototypeMediaUploadReceiverTest {
  private var counter = 0
  private val files = FakeMediaFiles()
  private val receiver = newReceiver(files, newName = { "f${counter++}" })

  private val mp4 =
    hex(MediaCases.list("signatures").first { it.text("name") == "mp4 ftyp box" }.text("hex")!!)

  private fun upload(
    target: PrototypeMediaUploadReceiver,
    id: String,
    bytes: ByteArray,
    mimeType: String = "video/mp4",
  ): PrototypeMediaResult {
    val begun = target.begin(id, mimeType, bytes.size.toLong(), sha256(bytes))
    if (begun is PrototypeMediaResult.Rejected) return begun
    target.chunk(id, 0, bytes).let { if (it is PrototypeMediaResult.Rejected) return it }
    return target.commit(id)
  }

  @Test
  fun `contract media budget is separate and matches the TypeScript host`() {
    assertEquals(64 * 1024 * 1024, PrototypeMediaContract.MAX_PROTOTYPE_MEDIA_ASSET_BYTES)
    assertEquals(256 * 1024, PrototypeMediaContract.MAX_PROTOTYPE_VTT_ASSET_BYTES)
    assertEquals(16, PrototypeMediaContract.MAX_PROTOTYPE_MEDIA_ASSET_COUNT)
    assertEquals(128 * 1024 * 1024, PrototypeMediaContract.MAX_PROTOTYPE_MEDIA_ASSET_TOTAL_BYTES)
    assertEquals(1024 * 1024, PrototypeMediaContract.MAX_PROTOTYPE_MEDIA_CHUNK_BYTES)
    assertTrue(PrototypeMediaContract.MIME_TYPES.none { it in PrototypeAssetContract.MIME_TYPES })
  }

  @Test
  fun `rejection vocabulary matches the shared corpus`() {
    assertEquals(
      MediaCases.root.getValue("rejectionCodes").jsonArray.map { it.jsonPrimitive.content },
      PrototypeMediaRejection.entries.map { it.code },
    )
  }

  @TestFactory
  fun `shared signature cases`(): List<DynamicTest> =
    MediaCases.list("signatures").map { case ->
      DynamicTest.dynamicTest(case.text("name")!!) {
        val head =
          hex(case.text("hex")!!).take(PrototypeMediaContract.SIGNATURE_PROBE_BYTES).toByteArray()
        assertEquals(
          case.getValue("matches").jsonPrimitive.boolean,
          PrototypeMediaContract.signatureMatches(case.text("mimeType")!!, head),
        )
      }
    }

  @TestFactory
  fun `shared begin cases`(): List<DynamicTest> =
    MediaCases.list("begins").map { case ->
      DynamicTest.dynamicTest(case.text("name")!!) {
        val result =
          newReceiver(FakeMediaFiles())
            .begin(
              case.text("id")!!,
              case.text("mimeType")!!,
              case.getValue("size").jsonPrimitive.long,
              case.text("sha256")!!,
            )
        assertEquals(case.text("problem"), rejection(result))
      }
    }

  @TestFactory
  fun `shared stream cases leave no partial file on rejection`(): List<DynamicTest> =
    MediaCases.list("streams").map { case ->
      DynamicTest.dynamicTest(case.text("name")!!) {
        val fake = FakeMediaFiles()
        val target = newReceiver(fake, newName = { "f" })
        val content = hex(case.text("contentHex")!!)
        val begun =
          target.begin(
            "a",
            case.text("mimeType")!!,
            content.size.toLong(),
            case.text("sha256") ?: sha256(content),
          )
        assertIs<PrototypeMediaResult.Accepted>(begun)
        val chunkResults =
          case
            .getValue("chunks")
            .jsonArray
            .map { it.jsonObject }
            .asSequence()
            .map { chunk ->
              target.chunk(
                "a",
                chunk.getValue("offset").jsonPrimitive.long,
                hex(chunk.text("hex")!!),
              )
            }
        val failed = chunkResults.firstOrNull { it is PrototypeMediaResult.Rejected }
        val result = failed ?: target.commit("a")
        val expected = case.text("expect")
        if (expected == "stored") {
          assertIs<PrototypeMediaResult.Stored>(result)
          assertTrue(content.contentEquals(fake.committed.getValue("f")))
          assertNotNull(target.lookup("a"))
        } else {
          assertEquals(expected, rejection(result))
          assertTrue(fake.partials.isEmpty(), "partial file left behind")
          assertTrue(fake.committed.isEmpty())
          assertNull(target.lookup("a"))
          assertEquals("unknown_upload", rejection(target.commit("a")))
        }
      }
    }

  @Test
  fun `a full store rejects a new upload without evicting`() {
    val small =
      newReceiver(
        files,
        PrototypeMediaLimits(maxCount = 2),
        newName = { "f${counter++}" },
      )
    assertIs<PrototypeMediaResult.Stored>(upload(small, "a", mp4))
    assertIs<PrototypeMediaResult.Stored>(upload(small, "b", mp4))
    assertEquals("count_limit", rejection(small.begin("c", "video/mp4", 36, sha256(mp4))))
    assertNotNull(small.lookup("a"))
    assertNotNull(small.lookup("b"))
    assertEquals(2, files.committed.size)
    // Replacing an existing id does not count it twice.
    assertIs<PrototypeMediaResult.Stored>(upload(small, "a", mp4)).also { assertTrue(it.replaced) }
    assertEquals(2, files.committed.size)
  }

  @Test
  fun `concurrent replacements reserve each id once`() {
    val small =
      newReceiver(
        files,
        PrototypeMediaLimits(maxCount = 2, maxTotalBytes = 72),
        newName = { "f${counter++}" },
      )
    assertIs<PrototypeMediaResult.Stored>(upload(small, "a", mp4))
    assertIs<PrototypeMediaResult.Stored>(upload(small, "b", mp4))
    assertIs<PrototypeMediaResult.Accepted>(small.begin("a", "video/mp4", 36, sha256(mp4)))
    assertIs<PrototypeMediaResult.Accepted>(small.begin("b", "video/mp4", 36, sha256(mp4)))
    assertEquals("count_limit", rejection(small.begin("c", "video/mp4", 1, sha256(mp4))))
    assertEquals("total_limit", rejection(small.begin("a", "video/mp4", 37, sha256(mp4))))
  }

  @Test
  fun `a smaller pending replacement keeps the committed bytes reserved`() {
    val small =
      newReceiver(
        files,
        PrototypeMediaLimits(maxTotalBytes = 50),
        newName = { "f${counter++}" },
      )
    assertIs<PrototypeMediaResult.Stored>(upload(small, "a", mp4))
    val smaller = mp4.copyOf(16)
    assertIs<PrototypeMediaResult.Accepted>(small.begin("a", "video/mp4", 16, sha256(smaller)))
    // 36 committed bytes stay reserved for 'a' until its replacement commits.
    assertEquals("total_limit", rejection(small.begin("b", "video/mp4", 16, sha256(smaller))))
    small.abort("a")
    assertEquals(36, small.lookup("a")!!.byteCount)
  }

  @Test
  fun `in-flight uploads count against the byte budget`() {
    val small =
      newReceiver(
        files,
        PrototypeMediaLimits(maxTotalBytes = 60),
        newName = { "f${counter++}" },
      )
    assertIs<PrototypeMediaResult.Accepted>(small.begin("a", "video/mp4", 36, sha256(mp4)))
    assertEquals("total_limit", rejection(small.begin("b", "video/mp4", 36, sha256(mp4))))
    small.abort("a")
    assertTrue(files.partials.isEmpty())
    assertIs<PrototypeMediaResult.Accepted>(small.begin("b", "video/mp4", 36, sha256(mp4)))
  }

  @Test
  fun `a replacement keeps the old asset readable until it commits`() {
    assertIs<PrototypeMediaResult.Stored>(upload(receiver, "clip", mp4))
    val first = receiver.lookup("clip")!!
    receiver.begin("clip", "video/mp4", 36, sha256(ByteArray(36)))
    receiver.chunk("clip", 0, mp4.copyOf(12))
    assertEquals(first, receiver.lookup("clip"))
    receiver.abort("clip")
    assertEquals(first, receiver.lookup("clip"))
    assertTrue(files.committed.containsKey(first.fileName))
  }

  @Test
  fun `chunks over the cap and malformed base64 are rejected before decoding`() {
    val tiny = newReceiver(files, PrototypeMediaLimits(maxChunkBytes = 12))
    tiny.begin("a", "video/mp4", 36, sha256(mp4))
    assertEquals("chunk_too_large", rejection(tiny.chunkBase64("a", 0, "A".repeat(17))))
    tiny.begin("a", "video/mp4", 36, sha256(mp4))
    assertEquals("invalid_base64", rejection(tiny.chunkBase64("a", 0, "!!!!")))
    tiny.begin("a", "video/mp4", 36, sha256(mp4))
    assertEquals("chunk_too_large", rejection(tiny.chunk("a", 0, mp4.copyOf(13))))
    assertTrue(files.partials.isEmpty())
  }

  @Test
  fun `a storage failure drops the upload`() {
    val failing = FakeMediaFiles(failAppend = true)
    val target = newReceiver(failing)
    target.begin("a", "video/mp4", 36, sha256(mp4))
    assertEquals("storage_failure", rejection(target.chunk("a", 0, mp4)))
    assertTrue(failing.partials.isEmpty())
  }

  @Test
  fun `clear drops committed and in-flight media`() {
    upload(receiver, "a", mp4)
    receiver.begin("b", "video/mp4", 36, sha256(mp4))
    receiver.clear()
    assertTrue(files.committed.isEmpty())
    assertTrue(files.partials.isEmpty())
    assertNull(receiver.lookup("a"))
  }

  @Test
  fun `directory files publish by rename and discard partial bytes`() {
    val dir = Files.createTempDirectory("media").toFile()
    try {
      val target =
        newReceiver(
          DirectoryPrototypeMediaFiles(dir),
          newName = { "n${counter++}" },
        )
      assertIs<PrototypeMediaResult.Stored>(upload(target, "a", mp4))
      assertTrue(mp4.contentEquals(target.file("a")!!.readBytes()))
      target.begin("b", "video/mp4", 36, sha256(ByteArray(36)))
      target.chunk("b", 0, mp4)
      assertEquals("sha256_mismatch", rejection(target.commit("b")))
      assertEquals(listOf("n0"), dir.list()!!.sorted())
    } finally {
      dir.deleteRecursively()
    }
  }
}
