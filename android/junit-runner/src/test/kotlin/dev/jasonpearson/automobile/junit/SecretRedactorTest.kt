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
  fun `parses multiline flow sequence with closing bracket on its own line`() {
    // The bracketed flow value spans multiple lines with `]` alone on the last line — the form the
    // line scanner previously dropped, silently disabling redaction (#6097 fail-open gap).
    val yaml =
      """
      name: P
      secretParameters: [
        TOKEN,
        PASSWORD
      ]
      steps:
        - tool: observe
      """
        .trimIndent()
    assertEquals(setOf("TOKEN", "PASSWORD"), SecretRedactor.parsePlanSecretKeys(yaml))
  }

  @Test
  fun `parses multiline flow sequence with trailing comma and closing bracket trailing an item`() {
    val yaml =
      """
      name: P
      secretParameters: [
        TOKEN,
        PASSWORD,
        API ]
      steps:
        - tool: observe
      """
        .trimIndent()
    assertEquals(setOf("TOKEN", "PASSWORD", "API"), SecretRedactor.parsePlanSecretKeys(yaml))
  }

  @Test
  fun `multiline flow sequence tolerates quoted comma and placeholder key names`() {
    val yaml =
      """
      name: P
      secretParameters: [
        "API,TOKEN",
        ${'$'}{SECRET_KEY}
      ]
      steps:
        - tool: observe
      """
        .trimIndent()
    assertEquals(setOf("API,TOKEN", "\${SECRET_KEY}"), SecretRedactor.parsePlanSecretKeys(yaml))
  }

  @Test
  fun `empty multiline flow sequence yields an empty set`() {
    val yaml =
      """
      name: P
      secretParameters: [
      ]
      steps:
        - tool: observe
      """
        .trimIndent()
    assertTrue(SecretRedactor.parsePlanSecretKeys(yaml).isEmpty())
  }

  @Test
  fun `multiline flow with a quoted hash key does not drop the following key`() {
    // A `#` inside a quoted item is literal YAML, not a comment. Stripping comments line-by-line
    // before quote state truncates `"API#TOKEN"` to `"API`, the unterminated quote swallows the
    // rest,
    // and PASSWORD is dropped — its secret would reach the LLM unredacted (#6097 Codex P1,
    // fail-open).
    val yaml =
      """
      name: P
      secretParameters: [
        "API#TOKEN",
        PASSWORD
      ]
      steps:
        - tool: observe
      """
        .trimIndent()
    assertEquals(setOf("API#TOKEN", "PASSWORD"), SecretRedactor.parsePlanSecretKeys(yaml))
  }

  @Test
  fun `multiline flow with an escaped quote before a bracket does not drop the following key`() {
    // A double-quoted scalar may contain an escaped quote (\"); the `]` after it is still inside
    // the
    // scalar, not the sequence terminator. Without escape tracking the terminator is found early
    // and
    // PASSWORD is dropped — fail-open (#6097 Codex P2).
    val yaml =
      """
      name: P
      secretParameters: [
        "a\"]b",
        PASSWORD
      ]
      steps:
        - tool: observe
      """
        .trimIndent()
    assertEquals(setOf("a\"]b", "PASSWORD"), SecretRedactor.parsePlanSecretKeys(yaml))
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
  fun `shorter secret substring of longer is fully redacted without residue`() {
    // "ab" is a substring of "abcdef"; longest-first replacement masks the whole "abcdef" rather
    // than
    // leaving a "cdef" residue (which shortest-first would).
    val values = SecretRedactor.secretValues(listOf("ab", "abcdef"))
    val result = SecretRedactor.redact("x abcdef y", values)
    assertEquals("x ${SecretRedactor.PLACEHOLDER} y", result)
    assertFalse(result.contains("cdef"), "no substring residue may remain")
  }

  @Test
  fun `empty values are ignored`() {
    assertEquals(
      "unchanged",
      SecretRedactor.redact("unchanged", SecretRedactor.secretValues(listOf(""))),
    )
  }
}
