package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.io.IOException
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeMediaStoreTest {
  private val files = FakePrototypeMediaFiles()

  @Test
  fun `put list lookup read remove and clear manage both files`() {
    val store = store()
    val first = putImage(store, thumbnail = byteArrayOf(2))
    val second = putImage(store)
    assertEquals("media:00000000-0000-0000-0000-000000000001", first.id)
    assertEquals("${first.id}/thumb", first.thumbnail)
    assertEquals(listOf(first, second), store.list())
    assertEquals(first, store.lookup(first.id))
    assertArrayEquals(byteArrayOf(1), store.read(first.id))
    assertArrayEquals(byteArrayOf(2), store.read(requireNotNull(first.thumbnail)))
    assertTrue(files.data.keys.all { it.matches(Regex("asset-[0-9]+")) })

    assertFalse(store.remove(requireNotNull(first.thumbnail)))
    assertTrue(store.remove(first.id))
    assertFalse(store.remove(first.id))
    assertNull(store.lookup(first.id))
    assertNull(store.read(first.id))
    assertNull(store.read(requireNotNull(first.thumbnail)))
    assertEquals(1, files.data.size)

    store.clear()
    assertTrue(store.list().isEmpty())
    assertNull(store.read(second.id))
    assertTrue(files.data.isEmpty())
  }

  @Test
  fun `missing file reads as null and preserves metadata`() {
    val store = store()
    val item = putImage(store)
    files.data.clear()
    assertNull(store.read(item.id))
    assertEquals(listOf(item), store.list())
  }

  @Test
  fun `count limit rejects without evicting and removal recovers capacity`() {
    val store = store(PrototypeMediaLimits(maxCount = 1))
    val first = putImage(store)
    assertLimitWithoutEviction(store, first) { put(store) }

    assertTrue(store.remove(first.id))
    putImage(store)
    assertEquals(1, store.list().size)
  }

  @Test
  fun `total byte limit includes thumbnails and clear restores capacity`() {
    val store = store(PrototypeMediaLimits(maxTotalBytes = 3))
    val first = putImage(store, thumbnail = byteArrayOf(2, 3))
    assertLimitWithoutEviction(store, first) { put(store) }

    store.clear()
    putImage(store, thumbnail = byteArrayOf(2, 3))
  }

  @Test
  fun `each kind has its own byte limit`() {
    val store = store(PrototypeMediaLimits(maxImageBytes = 1, maxVideoBytes = 2, maxAudioBytes = 3))
    val first = putImage(store)
    assertLimitWithoutEviction(store, first) {
      put(store, PrototypeMediaKind.IMAGE, "image/jpeg", ByteArray(2))
    }
    assertLimitWithoutEviction(store, first) {
      put(store, PrototypeMediaKind.VIDEO, "video/mp4", ByteArray(3))
    }
    assertLimitWithoutEviction(store, first) {
      put(store, PrototypeMediaKind.AUDIO, "audio/mp4", ByteArray(4))
    }
    assertLimitWithoutEviction(store, first) { put(store, thumbnail = ByteArray(2)) }
  }

  @Test
  fun `invalid payload or MIME writes nothing`() {
    val store = store()
    assertRejected(PrototypeMediaRejection.EMPTY, put(store, bytes = byteArrayOf()))
    assertRejected(PrototypeMediaRejection.EMPTY, put(store, thumbnail = byteArrayOf()))
    assertRejected(PrototypeMediaRejection.UNSUPPORTED_MIME, put(store, mimeType = "text/plain"))
    assertRejected(PrototypeMediaRejection.UNSUPPORTED_MIME, put(store, mimeType = "image/"))
    assertRejected(PrototypeMediaRejection.KIND_MISMATCH, put(store, mimeType = "video/mp4"))
    assertTrue(files.data.isEmpty())
  }

  @Test
  fun `failed thumbnail write rolls back the original and the partial thumbnail`() {
    val store = store(PrototypeMediaLimits(maxCount = 1))
    files.failWrite = "asset-1"
    assertRejected(PrototypeMediaRejection.STORAGE_FAILURE, put(store, thumbnail = byteArrayOf(2)))
    assertTrue(store.list().isEmpty())
    assertTrue(files.data.isEmpty())
    putImage(store)
  }

  @Test
  fun `JSON uses wire names and omits absent fields`() {
    val store = store()
    val item = putImage(store)
    assertEquals(
      Json.parseToJsonElement(
        """{"asset":"${item.id}","kind":"image","mimeType":"image/jpeg","bytes":1,"source":"camera","createdAt":"$CREATED_AT"}""",
      ),
      item.toJson(),
    )

    val withMetadata =
      store.put(
        PrototypeMediaKind.VIDEO,
        "video/mp4",
        byteArrayOf(1),
        PrototypeMediaSource.LIBRARY,
        width = 80,
        height = 100,
        durationMs = 12,
        name = "clip.mp4",
        thumbnail = byteArrayOf(2),
      ) as PrototypeMediaPutResult.Stored
    val video = withMetadata.item
    assertEquals(12L, video.durationMs)
    assertEquals("clip.mp4", video.name)
    assertEquals(
      Json.parseToJsonElement(
        """{"asset":"${video.id}","kind":"video","mimeType":"video/mp4","width":80,"height":100,"bytes":1,"source":"library","createdAt":"$CREATED_AT","thumbnail":"${video.id}/thumb"}""",
      ),
      video.toJson(),
    )
  }

  private fun assertLimitWithoutEviction(
    store: PrototypeMediaStore,
    first: PrototypeMediaItem,
    attempt: () -> PrototypeMediaPutResult,
  ) {
    val written = files.data.toMap()
    val rejection = assertRejected(PrototypeMediaRejection.MEDIA_LIMIT, attempt())
    assertEquals("media_limit", rejection.reason.detail)
    assertEquals(listOf(first), store.list())
    assertEquals(written, files.data)
    assertArrayEquals(byteArrayOf(1), store.read(first.id))
  }

  private fun assertRejected(
    expected: PrototypeMediaRejection,
    result: PrototypeMediaPutResult,
  ): PrototypeMediaPutResult.Rejected {
    val rejection = result as PrototypeMediaPutResult.Rejected
    assertEquals(expected, rejection.reason)
    return rejection
  }

  private fun putImage(
    store: PrototypeMediaStore,
    thumbnail: ByteArray? = null,
  ): PrototypeMediaItem = (put(store, thumbnail = thumbnail) as PrototypeMediaPutResult.Stored).item

  private fun put(
    store: PrototypeMediaStore,
    kind: PrototypeMediaKind = PrototypeMediaKind.IMAGE,
    mimeType: String = "image/jpeg",
    bytes: ByteArray = byteArrayOf(1),
    thumbnail: ByteArray? = null,
  ): PrototypeMediaPutResult =
    store.put(kind, mimeType, bytes, PrototypeMediaSource.CAMERA, thumbnail = thumbnail)

  private fun store(limits: PrototypeMediaLimits = PrototypeMediaLimits()): PrototypeMediaStore {
    var nextId = 0
    return DefaultPrototypeMediaStore(
      files,
      newId = { "00000000-0000-0000-0000-${(++nextId).toString().padStart(12, '0')}" },
      clock = { CREATED_AT },
      limits,
    )
  }

  private companion object {
    const val CREATED_AT = "2026-11-19T00:00:00Z"
  }
}

private class FakePrototypeMediaFiles : PrototypeAssetFiles {
  val data = mutableMapOf<String, ByteArray>()
  var failWrite: String? = null

  override fun write(name: String, bytes: ByteArray) {
    data[name] = bytes.copyOf()
    if (name == failWrite) throw IOException("Fake write failure")
  }

  override fun read(name: String): ByteArray? = data[name]?.copyOf()

  override fun delete(name: String) {
    data.remove(name)
  }

  override fun deleteAll() = data.clear()
}
