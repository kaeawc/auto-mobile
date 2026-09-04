package dev.jasonpearson.automobile.junit

import java.text.Normalizer
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Direct redaction-completeness tests for [SecretRedactor] (#6029 review): nested substitution,
 * Unicode normalization, and parameterized secret key names. Mirrors the iOS
 * `SecretRedactionCompletenessTests`.
 */
class SecretRedactorTest {

  @Test
  fun `redacts fully resolved nested secret value`() {
    // TOKEN's value embeds ${ENV}; the resolved form is what lands in the plan and must be
    // scrubbed.
    val params = mapOf<String, Any>("TOKEN" to "pre-\${ENV}", "ENV" to "live")
    val values = SecretRedactor.secretValues(setOf("TOKEN"), params)
    assertEquals(
      "typed ${SecretRedactor.PLACEHOLDER} into field",
      SecretRedactor.redact("typed pre-live into field", values),
    )
  }

  @Test
  fun `redacts secret regardless of unicode normalization`() {
    // Force NFC regardless of this source file's on-disk encoding so the NFD occurrence truly
    // differs.
    val composed = Normalizer.normalize("café-token", Normalizer.Form.NFC)
    val values = SecretRedactor.secretValues(setOf("K"), mapOf<String, Any>("K" to composed))
    val decomposed = Normalizer.normalize(composed, Normalizer.Form.NFD)
    val result = SecretRedactor.redact("error: $decomposed seen", values)
    assertTrue(result.contains(SecretRedactor.PLACEHOLDER))
    assertFalse(result.contains('\u0301'), "the decomposed combining mark must be gone")
  }

  @Test
  fun `resolveKeyNames resolves a parameterized key name`() {
    val params = mapOf<String, Any>("SECRET_KEY" to "apiToken", "apiToken" to "s3cr3t")
    val keys = SecretRedactor.resolveKeyNames(setOf("\${SECRET_KEY}"), params)
    assertTrue(keys.contains("apiToken"))
    val values = SecretRedactor.secretValues(keys, params)
    assertEquals("x ${SecretRedactor.PLACEHOLDER} y", SecretRedactor.redact("x s3cr3t y", values))
  }

  @Test
  fun `literal key resolves to itself`() {
    assertEquals(
      setOf("TOKEN"),
      SecretRedactor.resolveKeyNames(setOf("TOKEN"), mapOf("TOKEN" to "v")),
    )
  }
}
