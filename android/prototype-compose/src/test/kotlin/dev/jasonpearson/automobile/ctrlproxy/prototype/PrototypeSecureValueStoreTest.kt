package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PrototypeSecureValueStoreTest {
  @get:Rule val temp = TemporaryFolder()
  private val keys = FakeSecureKeys()
  private val warnings = mutableListOf<String>()

  private fun store() =
    FilePrototypeSecureValueStore(
      temp.root,
      PrototypeSecureCipher(keys, FakeNonceRandom()),
      PrototypeStorageWarn { message, error ->
        warnings += message
        assertNull(error)
      },
    )

  private val values =
    PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive("private-token-14321")))

  @Test
  fun `encrypted round trip survives a fresh store without plaintext or key names on disk`() {
    store().save("vault", values)
    val bytes = temp.root.listFiles()!!.single().readText()
    assertFalse(bytes.contains("private-token-14321"))
    assertFalse(bytes.contains("state:token"))
    assertFalse(
      bytes.contains(
        java.util.Base64.getEncoder().encodeToString(keys.values.values.single().encoded),
      ),
    )
    assertEquals(values, store().load("vault"))
    assertTrue(warnings.isEmpty())
  }

  @Test
  fun `maximum sized escaped utf8 values survive the file envelope`() {
    val stored =
      PrototypeStoredValues(
        1,
        (0 until 8).associate { "state:token_$it" to JsonPrimitive("\u0000".repeat(4096)) },
      )
    store().save("vault", stored)
    assertEquals(stored, store().load("vault"))
  }

  @Test
  fun `ids with the same slug cannot read each others ciphertext`() {
    store().save("vault/a", values)
    assertNull(store().load("vault?a"))
    store().save("vault?a", values.copy(version = 2))
    assertEquals(1, store().load("vault/a")!!.version)
    assertEquals(2, store().load("vault?a")!!.version)
    assertEquals(2, keys.values.size)
  }

  @Test
  fun `clear deletes the ciphertext and alias`() {
    store().save("vault", values)
    assertEquals(1, store().delete("vault"))
    assertTrue(temp.root.listFiles()!!.isEmpty())
    assertTrue(keys.values.isEmpty())
    assertNull(store().load("vault"))
  }

  @Test
  fun `corrupt ciphertext and missing key are absent with a fixed safe warning`() {
    store().save("vault", values)
    keys.values.clear()
    assertNull(store().load("vault"))
    temp.root.listFiles()!!.single().writeText("private-token-14321")
    assertNull(store().load("vault"))
    assertEquals(2, warnings.size)
    assertTrue(warnings.all { it == "Secure prototype values are unavailable" })
  }

  @Test
  fun `authenticated ciphertext tampering and wrong keys are absent without exception details`() {
    val vault = store()
    vault.save("vault", values)
    val file = temp.root.listFiles()!!.single()
    val encrypted = java.util.Base64.getDecoder().decode(file.readText())
    encrypted[encrypted.lastIndex] = (encrypted.last().toInt() xor 1).toByte()
    file.writeText(java.util.Base64.getEncoder().encodeToString(encrypted))
    assertNull(vault.load("vault"))
    vault.save("vault", values)
    val alias = keys.values.keys.single()
    keys.values[alias] = SecretKeySpec(ByteArray(32), "AES")
    assertNull(vault.load("vault"))
    assertEquals(
      listOf("Secure prototype values are unavailable", "Secure prototype values are unavailable"),
      warnings,
    )
  }

  @Test
  fun `every write uses a different nonce and authenticates the full prototype id`() {
    val sharedKeys = FakeSecureKeys(SecretKeySpec(ByteArray(32) { 7 }, "AES"))
    val cipher = PrototypeSecureCipher(sharedKeys, FakeNonceRandom())
    val first = cipher.encrypt("vault/a", byteArrayOf(1, 2, 3))
    val second = cipher.encrypt("vault/a", byteArrayOf(1, 2, 3))
    cipher.encrypt("vault?a", byteArrayOf(1, 2, 3))
    assertFalse(first.contentEquals(second))
    assertArrayEquals(byteArrayOf(1, 2, 3), cipher.decrypt("vault/a", first))
    try {
      cipher.decrypt("vault?a", first)
      fail("Cross-prototype decryption must fail")
    } catch (_: java.security.GeneralSecurityException) {
      assertTrue(true)
    }
  }
}

/** AndroidKeyStore entries in memory; [corrupt] aliases throw like a restored, unusable entry. */
private class FakeKeystoreEntries : PrototypeKeystoreEntries {
  val keys = mutableMapOf<String, SecretKey>()
  val corrupt = mutableSetOf<String>()
  val deleted = mutableListOf<String>()
  private var generated = 0

  override fun get(alias: String): SecretKey? {
    if (alias in corrupt) throw java.security.UnrecoverableKeyException("entry ${alias}")
    return keys[alias]
  }

  override fun generate(alias: String): SecretKey =
    SecretKeySpec(ByteArray(32) { (++generated).toByte() }, "AES").also { keys[alias] = it }

  override fun delete(alias: String) {
    deleted += alias
    corrupt.remove(alias)
    keys.remove(alias)
  }
}

class AndroidPrototypeSecureKeyProviderTest {
  @get:Rule val temp = TemporaryFolder()
  private val entries = FakeKeystoreEntries()
  private val warnings = mutableListOf<String>()
  private val provider =
    AndroidPrototypeSecureKeyProvider(
      entries,
      PrototypeStorageWarn { message, error ->
        warnings += message
        assertNull(error)
      },
    )

  private fun store() =
    FilePrototypeSecureValueStore(
      temp.root,
      PrototypeSecureCipher(provider),
      PrototypeStorageWarn { message, _ -> warnings += message },
    )

  private val values =
    PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive("private-token-14321")))

  @Test
  fun `an unrecoverable key is deleted and recreated and its old ciphertext is unreadable`() {
    store().save("vault", values)
    val alias = entries.keys.keys.single()
    entries.corrupt += alias

    assertNull(store().load("vault"))
    assertEquals(listOf(alias), entries.deleted)
    assertFalse(alias in entries.keys)

    entries.corrupt += alias
    store().save("vault", values.copy(version = 2))
    assertEquals(2, store().load("vault")!!.version)
    assertEquals(
      listOf(
        "Secure storage key was unrecoverable; stored secure values were discarded",
        "Secure prototype values are unavailable",
        "Secure storage key was unrecoverable; stored secure values were discarded",
      ),
      warnings,
    )
    assertFalse(warnings.any { it.contains(alias) || it.contains("private-token") })
  }
}

internal class FakeSecureKeys(private val sharedKey: SecretKey? = null) :
  PrototypeSecureKeyProvider {
  val values = mutableMapOf<String, SecretKey>()

  override fun key(alias: String, create: Boolean): SecretKey? =
    values[alias]
      ?: if (create)
        (sharedKey ?: SecretKeySpec(ByteArray(32) { (values.size + 1).toByte() }, "AES")).also {
          values[alias] = it
        }
      else null

  override fun delete(alias: String) {
    values.remove(alias)
  }
}

private class FakeNonceRandom : java.security.SecureRandom() {
  private var next = 0

  override fun nextBytes(bytes: ByteArray) {
    bytes.indices.forEach { bytes[it] = (next++).toByte() }
  }
}
