package dev.jasonpearson.automobile.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/**
 * The secure-key restore rule (#14321, #16563), mirroring the `secure key restore (#14321)` block
 * of `test/features/prototype/prototypeStorage.test.ts`.
 */
class PrototypeStorageSecureRestoreTest {
  private fun spec(
    storage: String = SECURE_STORAGE,
    pin: String = "",
    requires: Boolean = true,
  ): PrototypeSpec {
    val requiresField =
      if (requires) ""","requires":{"platform":["secureStorage","biometric"]}""" else ""
    val input =
      """{"id":"vault","window":{"placement":{"type":"fullscreen"}},""" +
        """"state":{"token":"","pin":"$pin","count":0}$requiresField,"storage":$storage,""" +
        """"root":{"type":"text","text":"x"}}"""
    val validation = PrototypeSpecValidator.validate(input)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  private fun noStorageSpec(): PrototypeSpec {
    val input =
      """{"id":"vault","window":{"placement":{"type":"fullscreen"}},""" +
        """"state":{"token":"","pin":"","count":0},"root":{"type":"text","text":"x"}}"""
    val validation = PrototypeSpecValidator.validate(input)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  private fun secure(
    vararg values: Pair<String, JsonElement>,
    invalidated: List<String> = emptyList(),
    version: Int = 1,
  ) = PrototypeStoredValues(version, emptyMap(), linkedMapOf(*values), invalidated)

  private fun PrototypeStorageRestore.text(key: String): String? =
    (spec.state?.get(key) as? PrototypeScalar.Text)?.value

  private fun drop(key: String, reason: PrototypeStorageDropReason) =
    PrototypeStorageDrop(key, reason)

  @Test
  fun `a secure value restores into its string state key`() {
    val restore =
      PrototypeStorageRestorer.restore(spec(), secure("state:token" to JsonPrimitive("abc")))
    assertEquals("abc", restore.text("token"))
    assertEquals(listOf("state:token"), restore.applied)
    assertEquals(emptyList(), restore.dropped)
    assertEquals(emptyList(), restore.locked)
  }

  @Test
  fun `a biometric-bound value stays locked and its state holds an empty string`() {
    val restore =
      PrototypeStorageRestorer.restore(
        spec(pin = "authored"),
        secure("state:pin" to JsonPrimitive("1234")),
      )
    assertEquals("", restore.text("pin"))
    assertEquals(listOf("state:pin"), restore.locked)
    assertEquals(emptyList(), restore.applied)
  }

  @Test
  fun `a sealed biometric value is locked without reading its content`() {
    val restore = PrototypeStorageRestorer.restore(spec(), secure("state:pin" to JsonNull))
    assertEquals(listOf("state:pin"), restore.locked)
    assertEquals(emptyList(), restore.dropped)
  }

  @Test
  fun `a biometric key with no stored value is not locked`() {
    val restore = PrototypeStorageRestorer.restore(spec(), secure())
    assertEquals(emptyList(), restore.locked)
    assertEquals("", restore.text("pin"))
  }

  @Test
  fun `an invalidated key drops its value and the spec's value stands`() {
    val restore =
      PrototypeStorageRestorer.restore(
        spec(pin = "authored"),
        secure("state:pin" to JsonNull, invalidated = listOf("state:pin")),
      )
    assertEquals("authored", restore.text("pin"))
    assertEquals(emptyList(), restore.locked)
    assertEquals(
      listOf(drop("state:pin", PrototypeStorageDropReason.INVALIDATED)),
      restore.dropped,
    )
  }

  @Test
  fun `a changed version, an unlisted key or no storage block drops secure values`() {
    val authored = spec(storage = SECURE_STORAGE.replace("\"version\":1", "\"version\":2"))
    val changed =
      PrototypeStorageRestorer.restore(
        authored,
        secure("state:token" to JsonPrimitive("abc"), "state:pin" to JsonNull),
      )
    assertEquals(authored.state, changed.spec.state)
    assertEquals(emptyList(), changed.locked)
    assertEquals(
      listOf(
        drop("state:token", PrototypeStorageDropReason.VERSION),
        drop("state:pin", PrototypeStorageDropReason.VERSION),
      ),
      changed.dropped,
    )
    val unlisted =
      PrototypeStorageRestorer.restore(
        spec(storage = """{"version":1,"keys":[]}""", requires = false),
        secure("state:token" to JsonPrimitive("abc")),
      )
    assertEquals(
      listOf(drop("state:token", PrototypeStorageDropReason.UNLISTED)),
      unlisted.dropped,
    )
    val noBlock =
      PrototypeStorageRestorer.restore(
        noStorageSpec(),
        secure("state:token" to JsonPrimitive("abc")),
      )
    assertEquals("", noBlock.text("token"))
    assertEquals(
      listOf(drop("state:token", PrototypeStorageDropReason.UNLISTED)),
      noBlock.dropped,
    )
  }

  @Test
  fun `a value that is not a string, is too large or fills a non-string key is a mismatch`() {
    // `state:count` is a number key, so the validator refuses it in storage.secure; build the
    // listing by hand to reach the restorer's own check, as the TypeScript test does.
    val authored = spec()
    val withCount =
      authored.copy(
        storage = authored.storage?.copy(secure = listOf("state:token", "state:count")),
      )
    val restore =
      PrototypeStorageRestorer.restore(
        withCount,
        secure("state:token" to JsonPrimitive(42), "state:count" to JsonPrimitive("7")),
      )
    assertEquals(withCount.state, restore.spec.state)
    assertEquals(
      listOf(
        drop("state:token", PrototypeStorageDropReason.MISMATCH),
        drop("state:count", PrototypeStorageDropReason.MISMATCH),
      ),
      restore.dropped,
    )
    val atLimit = "é".repeat(PrototypeStorageRestorer.maxSecureValueBytes / 2)
    val fits =
      PrototypeStorageRestorer.restore(spec(), secure("state:token" to JsonPrimitive(atLimit)))
    assertEquals(listOf("state:token"), fits.applied)
    val over =
      PrototypeStorageRestorer.restore(
        spec(),
        secure("state:token" to JsonPrimitive("${atLimit}a")),
      )
    assertEquals(
      listOf(drop("state:token", PrototypeStorageDropReason.MISMATCH)),
      over.dropped,
    )
    assertEquals(4096, PrototypeStorageRestorer.maxSecureValueBytes)
  }

  @Test
  fun `a plaintext stored copy of a secure key never restores into it`() {
    val restore =
      PrototypeStorageRestorer.restore(
        spec(),
        PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive("leaked"))),
      )
    assertEquals("", restore.text("token"))
    assertEquals(
      listOf(drop("state:token", PrototypeStorageDropReason.UNLISTED)),
      restore.dropped,
    )
  }

  private companion object {
    const val SECURE_STORAGE =
      """{"version":1,"keys":[],"secure":["state:token","state:pin"],""" +
        """"secureAuth":{"state:pin":"biometric"}}"""
  }
}
