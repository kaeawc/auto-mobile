package dev.jasonpearson.automobile.contentseeder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

private class FakeContactPhotoAccess : ContactPhotoAccess {
  val operations = mutableListOf<String>()
  var owned = true
  var persisted = true
  var bytes = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
  var failInsert = false

  override fun ownsContact(namespace: String, rawContactId: Long): Boolean {
    operations.add("owner:$namespace:$rawContactId")
    return owned
  }

  override fun readPhoto(name: String): ByteArray {
    operations.add("read:$name")
    return bytes
  }

  override fun insertPhoto(rawContactId: Long, bytes: ByteArray) {
    operations.add("insert:$rawContactId:${bytes.size}")
    check(!failInsert) { "Provider refused" }
  }

  override fun hasPhoto(rawContactId: Long): Boolean {
    operations.add("verify:$rawContactId")
    return persisted
  }

  override fun deletePhoto(name: String) {
    operations.add("delete:$name")
  }
}

class ContactPhotoSeederTest {
  private val request = SeedRequest.Photo("ns1", 3, "automobile.ns1.3.photo")

  @Test
  fun writesValidPhotoAfterOwnershipCheckAndVerifiesBeforeDeletingStagedFile() {
    val access = FakeContactPhotoAccess()
    assertEquals(1, seedContactPhoto(request, access))
    assertEquals(
      listOf(
        "owner:ns1:3",
        "read:automobile.ns1.3.photo",
        "insert:3:8",
        "verify:3",
        "delete:automobile.ns1.3.photo",
      ),
      access.operations,
    )
  }

  @Test
  fun rejectsWrongNamespaceBadMagicAndOversizeAndAlwaysCleansUp() {
    for (problem in listOf("namespace", "magic", "size", "insert", "readback")) {
      val access = FakeContactPhotoAccess()
      when (problem) {
        "namespace" -> access.owned = false
        "magic" -> access.bytes = byteArrayOf(1, 2, 3)
        "size" -> access.bytes = ByteArray(512 * 1024 + 1)
        "insert" -> access.failInsert = true
        "readback" -> access.persisted = false
      }
      assertThrows(RuntimeException::class.java) { seedContactPhoto(request, access) }
      assertEquals("delete:automobile.ns1.3.photo", access.operations.last())
      if (problem in listOf("namespace", "magic", "size")) {
        assertEquals(false, access.operations.any { it.startsWith("insert:") })
      }
    }
  }

  @Test
  fun acceptsJpegAtTheSizeLimit() {
    val access = FakeContactPhotoAccess()
    access.bytes = ByteArray(512 * 1024)
    byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte()).copyInto(access.bytes)
    assertEquals(1, seedContactPhoto(request, access))
  }
}
