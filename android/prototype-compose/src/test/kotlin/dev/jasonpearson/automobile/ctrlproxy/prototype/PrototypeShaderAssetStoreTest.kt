package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeShaderAssetStoreTest {
  private class Files : PrototypeAssetFiles {
    var writes = 0

    override fun write(name: String, bytes: ByteArray) {
      writes++
    }

    override fun read(name: String): ByteArray? = null

    override fun delete(name: String) {}

    override fun deleteAll() {}
  }

  @Test
  fun `AGSL has a 16 KiB cap and runtime refusal before any write`() {
    val files = Files()
    val store = PrototypeAssetStore(files)
    assertEquals(16384, store.limits.maxShaderBytes)
    for (size in listOf(1, 16384, 16385)) {
      val result =
        store.put("effect", "application/vnd.automobile.agsl", ByteArray(size) { 32 })
          as PrototypeAssetPutResult.Rejected
      if (size > 16384) {
        assertEquals(PrototypeAssetRejection.TOO_LARGE, result.reason)
        assertTrue(result.message, result.message.contains("16384"))
      } else {
        assertEquals(PrototypeAssetRejection.UNSUPPORTED_MIME_TYPE, result.reason)
        assertTrue(result.message, result.message.contains("not supported by this runtime yet"))
      }
      assertNull(store.lookup("effect"))
      assertEquals(0, store.count)
      assertEquals(0, files.writes)
    }
  }

  @Test
  fun `generic cap still bounds AGSL when configured smaller`() {
    val store = PrototypeAssetStore(Files(), PrototypeAssetLimits(maxAssetBytes = 8))
    val result =
      store.put("effect", "application/vnd.automobile.agsl", ByteArray(9))
        as PrototypeAssetPutResult.Rejected
    assertEquals(PrototypeAssetRejection.TOO_LARGE, result.reason)
    assertTrue(result.message, result.message.contains("limit is 8"))
  }
}
