package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeStorageRestorer
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.Base64
import kotlinx.serialization.json.*

/** One encrypted, atomically replaced document per full prototype id, separate from plaintext. */
internal class FilePrototypeSecureValueStore(
  private val root: File,
  private val cipher: PrototypeSecureCipher,
  private val warn: PrototypeStorageWarn = PrototypeStorageWarn { message, _ ->
    Log.w("PrototypeStorage", message)
  },
) : PrototypeSecureValueStore {
  @Synchronized
  override fun load(id: String): PrototypeStoredValues? {
    val file = fileFor(id)
    if (!file.exists()) return null
    return try {
      require(file.length() <= MAX_FILE_BYTES)
      val document =
        Json.parseToJsonElement(
            String(
              cipher.decrypt(id, Base64.getDecoder().decode(file.readBytes())),
              Charsets.UTF_8,
            ),
          )
          .jsonObject
      val version = document.getValue("version").jsonPrimitive.int
      val values = document.getValue("values").jsonObject
      require(
        version > 0 &&
          values.all { (key, value) ->
            key.startsWith("state:") &&
              value is JsonPrimitive &&
              value.isString &&
              value.content.toByteArray(Charsets.UTF_8).size <=
                PrototypeStorageRestorer.maxSecureValueBytes
          },
      )
      PrototypeStoredValues(version, values)
    } catch (@Suppress("TooGenericExceptionCaught") ignored: Exception) {
      // Crypto, parsers and providers may include input in exceptions. Never forward the cause.
      warn.warn("Secure prototype values are unavailable", null)
      null
    }
  }

  @Synchronized
  override fun save(id: String, stored: PrototypeStoredValues) {
    try {
      require(
        stored.values.all { (key, value) ->
          key.startsWith("state:") &&
            value is JsonPrimitive &&
            value.isString &&
            value.content.toByteArray(Charsets.UTF_8).size <=
              PrototypeStorageRestorer.maxSecureValueBytes
        },
      )
      if (!root.isDirectory && !root.mkdirs() && !root.isDirectory) throw IOException()
      val document = buildJsonObject {
        put("version", stored.version)
        put("values", JsonObject(stored.values))
      }
      val encrypted =
        Base64.getEncoder()
          .encode(cipher.encrypt(id, document.toString().toByteArray(Charsets.UTF_8)))
      val target = fileFor(id)
      val temp = File(root, "${target.name}.tmp")
      try {
        FileOutputStream(temp).use { out ->
          out.write(encrypted)
          out.flush()
          out.fd.sync()
        }
        if (!temp.renameTo(target)) throw IOException()
      } finally {
        if (temp.exists()) temp.delete()
      }
    } catch (@Suppress("TooGenericExceptionCaught") ignored: Exception) {
      throw IOException("Cannot store secure prototype values")
    }
  }

  @Synchronized
  override fun delete(id: String): Int {
    val count = load(id)?.values?.size ?: 0
    try {
      val file = fileFor(id)
      if (file.exists() && !file.delete() && file.exists()) throw IOException()
      val temp = File(root, "${file.name}.tmp")
      if (temp.exists() && !temp.delete() && temp.exists()) throw IOException()
      cipher.delete(id)
    } catch (@Suppress("TooGenericExceptionCaught") ignored: Exception) {
      throw IOException("Cannot clear secure prototype values")
    }
    return count
  }

  private companion object {
    // Eight 4 KiB values may expand sixfold when JSON escapes control characters, then Base64.
    const val MAX_FILE_BYTES = 1048576L
  }

  private fun fileFor(id: String) = File(root, "${prototypeSecureFileName(id)}.secure")
}

object PrototypeSecureValueStores {
  private val stores = mutableMapOf<String, PrototypeSecureValueStore>()

  /** Service cleanup and Activity persistence share the same lock and private directory. */
  @Synchronized
  fun inDirectory(root: File): PrototypeSecureValueStore =
    stores.getOrPut(root.canonicalPath) {
      FilePrototypeSecureValueStore(
        File(root, "secure"),
        PrototypeSecureCipher(AndroidPrototypeSecureKeyProvider()),
      )
    }
}
