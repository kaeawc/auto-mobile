package dev.jasonpearson.automobile.junit

import java.text.Normalizer
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Direct tests for [SecretRedactor] — the RAW placeholder-tolerant key scanner and the Unicode-form
 * redaction. Resolution/substitution is the executor's job (tested end-to-end in
 * [AutoMobilePlanRedactionTest]). Mirrors iOS `PlanMetadataSecretParametersParsingTests` /
 * `SecretRedactionTests` (#6029 convergence).
 */
class SecretRedactorTest {

  @Test
  fun `parses flush and indented and inline secret parameter lists`() {
    val flush = "name: P\nsecretParameters:\n- TOKEN\n- PASSWORD\nsteps:\n  - tool: observe"
    assertEquals(setOf("TOKEN", "PASSWORD"), SecretRedactor.parsePlanSecretKeys(flush))

    val indented = "name: P\nsecretParameters:\n  - TOKEN\nsteps:\n  - tool: observe"
    assertEquals(setOf("TOKEN"), SecretRedactor.parsePlanSecretKeys(indented))

    val inline = "name: P\nsecretParameters: [TOKEN, \"PASSWORD\"]\nsteps:\n  - tool: observe"
    assertEquals(setOf("TOKEN", "PASSWORD"), SecretRedactor.parsePlanSecretKeys(inline))
  }

  @Test
  fun `inline list does not split on a comma inside quotes`() {
    val yaml = "name: P\nsecretParameters: [\"API,TOKEN\", plain]\nsteps:\n  - tool: observe"
    assertEquals(setOf("API,TOKEN", "plain"), SecretRedactor.parsePlanSecretKeys(yaml))
  }

  @Test
  fun `tolerates placeholder key names and unrelated placeholder flow lists`() {
    // A full YAML load would throw on `[${LABEL}, OK]`; the scanner tolerates it and ignores it.
    val yaml =
      """
      name: P
      secretParameters:
        - ${'$'}{SECRET_KEY}
      steps:
        - tool: observe
          waitFor:
            textAny: [${'$'}{LABEL}, OK]
        - tool: inputText
          text: "${'$'}{SECRET_KEY}"
      """
        .trimIndent()
    assertEquals(setOf("\${SECRET_KEY}"), SecretRedactor.parsePlanSecretKeys(yaml))
  }

  @Test
  fun `redacts secret regardless of unicode normalization`() {
    // Force NFC regardless of this source file's on-disk encoding so the NFD occurrence truly
    // differs.
    val composed = Normalizer.normalize("café-token", Normalizer.Form.NFC)
    val values = SecretRedactor.secretValues(listOf(composed))
    val decomposed = Normalizer.normalize(composed, Normalizer.Form.NFD)
    val result = SecretRedactor.redact("error: $decomposed seen", values)
    assertTrue(result.contains(SecretRedactor.PLACEHOLDER))
    assertFalse(result.contains('\u0301'), "the decomposed combining mark must be gone")
  }

  @Test
  fun `redacts longer secrets first`() {
    val values = SecretRedactor.secretValues(listOf("ab", "abcdef"))
    assertEquals("x ${SecretRedactor.PLACEHOLDER} y", SecretRedactor.redact("x abcdef y", values))
  }

  @Test
  fun `empty values are ignored`() {
    assertEquals(
      "unchanged",
      SecretRedactor.redact("unchanged", SecretRedactor.secretValues(listOf(""))),
    )
  }
}
