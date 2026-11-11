package dev.jasonpearson.automobile.contentseeder

import android.content.ContentValues
import android.content.Context
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Photo
import android.provider.ContactsContract.Data
import android.provider.ContactsContract.RawContacts
import java.io.File

/** Keep file/provider operations behind a seam so the photo workflow is JVM-testable. */
internal interface ContactPhotoAccess {
  fun ownsContact(namespace: String, rawContactId: Long): Boolean

  fun readPhoto(name: String): ByteArray

  fun insertPhoto(rawContactId: Long, bytes: ByteArray)

  fun hasPhoto(rawContactId: Long): Boolean

  fun deletePhoto(name: String)
}

internal fun seedContactPhoto(request: SeedRequest.Photo, access: ContactPhotoAccess): Int {
  try {
    check(access.ownsContact(request.namespace, request.rawContactId)) {
      "rawContactId is not owned by this namespace; retry with reset"
    }
    val bytes = access.readPhoto(request.photoFile)
    require(bytes.size <= MAX_PHOTO_BYTES && isContactPhoto(bytes)) {
      "photo must have PNG/JPEG magic bytes and be at most 512 KB (524288 bytes)"
    }
    access.insertPhoto(request.rawContactId, bytes)
    check(access.hasPhoto(request.rawContactId)) {
      "Contact photo read-back has no photo_id / photo_file_id; check image validity and Contacts permissions, then retry with reset"
    }
    return 1
  } finally {
    access.deletePhoto(request.photoFile)
  }
}

private fun isContactPhoto(bytes: ByteArray): Boolean {
  return bytes.take(8) ==
    listOf(
      0x89.toByte(),
      0x50.toByte(),
      0x4e.toByte(),
      0x47.toByte(),
      0x0d.toByte(),
      0x0a.toByte(),
      0x1a.toByte(),
      0x0a.toByte(),
    ) || bytes.take(3) == listOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte())
}

internal class AndroidContactPhotoAccess(context: Context) : ContactPhotoAccess {
  private val resolver = context.contentResolver
  private val cacheDir = context.cacheDir

  override fun ownsContact(namespace: String, rawContactId: Long): Boolean =
    checkNotNull(
        resolver.query(
          RawContacts.CONTENT_URI,
          arrayOf(RawContacts._ID),
          "${RawContacts._ID}=? AND ${RawContacts.ACCOUNT_NAME}=? AND ${RawContacts.ACCOUNT_TYPE}=?",
          arrayOf(rawContactId.toString(), "automobile.$namespace", ContentSeeder.ACCOUNT_TYPE),
          null,
        ),
      ) {
        "Contact ownership query returned no cursor; check READ_CONTACTS"
      }
      .use { it.count == 1 }

  override fun readPhoto(name: String): ByteArray {
    val file = File(cacheDir, name)
    require(file.isFile && file.length() <= MAX_PHOTO_BYTES) {
      "Staged photo is missing or exceeds 512 KB; check debug run-as cache staging"
    }
    // Bound the read as well as stat in case shell changes the file during staging.
    return file.inputStream().use { input ->
      val bytes = ByteArray(MAX_PHOTO_BYTES + 1)
      var size = 0
      while (size < bytes.size) {
        val read = input.read(bytes, size, bytes.size - size)
        if (read < 0) break
        size += read
      }
      bytes.copyOf(size)
    }
  }

  override fun insertPhoto(rawContactId: Long, bytes: ByteArray) {
    val values =
      ContentValues().apply {
        put(Data.RAW_CONTACT_ID, rawContactId)
        put(Data.MIMETYPE, Photo.CONTENT_ITEM_TYPE)
        put(Photo.PHOTO, bytes)
        put(Data.IS_PRIMARY, 1)
      }
    val uri =
      Data.CONTENT_URI.buildUpon()
        .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
        .build()
    // A Data BLOB insert creates the photo row/thumbnail synchronously (photo_id).
    // The provider may also create photo_file_id for a full-size display photo.
    checkNotNull(resolver.insert(uri, values)) {
      "Photo insert returned no URI; check WRITE_CONTACTS"
    }
  }

  override fun hasPhoto(rawContactId: Long): Boolean =
    checkNotNull(
        resolver.query(
          Data.CONTENT_URI,
          arrayOf(Data._ID),
          "${Data.RAW_CONTACT_ID}=? AND ${Data.MIMETYPE}=? AND (photo_id>0 OR photo_file_id>0)",
          arrayOf(rawContactId.toString(), Photo.CONTENT_ITEM_TYPE),
          null,
        ),
      ) {
        "Photo query returned no cursor; check READ_CONTACTS"
      }
      .use { it.count > 0 }

  override fun deletePhoto(name: String) {
    val file = File(cacheDir, name)
    check(!file.exists() || file.delete()) { "Could not delete the staged photo from app cache" }
  }
}

private const val MAX_PHOTO_BYTES = 512 * 1024
