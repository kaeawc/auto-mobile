package dev.jasonpearson.automobile.junit

import java.text.Normalizer
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
  fun `trailing comment after the closing bracket is ignored`() {
    // A comment after `]` (with or without a leading space) must be ignored and TOKEN still parsed;
    // dropping it would leak TOKEN's value (#6097 Codex — comment after `]`).
    val spaced = "name: P\nsecretParameters: [TOKEN] # trailing comment\nsteps:\n  - tool: observe"
    assertEquals(setOf("TOKEN"), SecretRedactor.parsePlanSecretKeys(spaced))
    val unspaced = "name: P\nsecretParameters: [TOKEN]#c\nsteps:\n  - tool: observe"
    assertEquals(setOf("TOKEN"), SecretRedactor.parsePlanSecretKeys(unspaced))
  }

  @Test
  fun `an unrecognized token is still captured as a secret key (fail-safe)`() {
    // Fail-safe: an unusual/unrecognized token must still be treated as a secret key (over-capture)
    // rather than dropped — dropping would fail open (#6097).
    val yaml = "name: P\nsecretParameters: [TOKEN, @@weird@@]\nsteps:\n  - tool: observe"
    assertEquals(setOf("TOKEN", "@@weird@@"), SecretRedactor.parsePlanSecretKeys(yaml))
  }

  @Test
  fun `an unterminated flow sequence fails safe by capturing its tokens`() {
    // No closing `]` (e.g. substitution truncation): still yield the tokens (over-capture), never
    // silently drop them (#6097 fail-safe).
    val yaml = "name: P\nsecretParameters: [\n  TOKEN,\n  PASSWORD"
    assertEquals(setOf("TOKEN", "PASSWORD"), SecretRedactor.parsePlanSecretKeys(yaml))
  }

  @Test
  fun `a double-quoted line-continuation key is captured`() {
    // A double-quoted key using YAML line continuation (`"API\`+newline+`TOKEN"` decodes to
    // `APITOKEN`) must be captured so its value is redacted (#6097 Codex — line continuation).
    val yaml = "name: P\nsecretParameters: [\n  \"API\\\n  TOKEN\"\n]\nsteps:\n  - tool: observe"
    assertEquals(setOf("APITOKEN"), SecretRedactor.parsePlanSecretKeys(yaml))
  }

  @Test
  fun `a CRLF-authored quoted multiline key is parsed without a carriage return`() {
    // With CRLF line endings, split('\n') leaves a trailing `\r`; it must be stripped so the key
    // isn't
    // corrupted (#6097 Codex — CRLF). The quoted scalar folds to `API TOKEN`.
    val yaml =
      "name: P\r\nsecretParameters: [\r\n  \"API\r\n  TOKEN\"\r\n]\r\nsteps:\r\n  - tool: observe"
    val keys = SecretRedactor.parsePlanSecretKeys(yaml)
    assertEquals(setOf("API TOKEN"), keys)
    assertFalse(keys.any { it.contains('\r') }, "no key may contain a carriage return")
  }

  @Test
  fun `a plain multiline flow scalar captures each line's token (fail-safe over-capture)`() {
    // A plain (unquoted) scalar spanning lines is captured token-per-line so both are redacted,
    // rather
    // than blended into one mis-named key (#6097 Codex — plain-scalar folding).
    val yaml = "name: P\nsecretParameters: [\n  API\n  TOKEN\n]\nsteps:\n  - tool: observe"
    assertEquals(setOf("API", "TOKEN"), SecretRedactor.parsePlanSecretKeys(yaml))
  }

  @Test
  fun `secretParameterValues matches exactly and does not over-redact`() {
    val values =
      SecretRedactor.secretParameterValues(setOf("TOKEN"), mapOf("TOKEN" to "S", "VIS" to "v"))
    assertEquals(listOf("S"), values)
  }

  @Test
  fun `secretParameterValues matches leniently across whitespace and case`() {
    // A folded/whitespaced key still resolves to the parameter by normalized identity (#6097).
    val values = SecretRedactor.secretParameterValues(setOf("API TOKEN"), mapOf("apitoken" to "S"))
    assertEquals(listOf("S"), values)
  }

  @Test
  fun `a quoted whitespace-only key is not dropped`() {
    // Stripping the quotes before the trim would discard `" "`; a single space is a valid quoted
    // key
    // and must be kept so its parameter value is redacted (#6097 Codex — quoted whitespace key).
    val yaml = "name: P\nsecretParameters: [\" \"]\nsteps:\n  - tool: observe"
    assertEquals(setOf(" "), SecretRedactor.parsePlanSecretKeys(yaml))
  }

  @Test
  fun `secretParameterValues keeps a quoted whitespace key's value`() {
    val values = SecretRedactor.secretParameterValues(setOf(" "), mapOf(" " to "SECRET"))
    assertEquals(listOf("SECRET"), values)
  }

  @Test
  fun `secretParameterValues over-redacts a backslash key despite a decoy exact-match`() {
    // The un-decoded hex key `API\x54OKEN` exact-matches a DECOY parameter of the same raw
    // spelling,
    // while the REAL value lives under the YAML-decoded `APITOKEN`. A backslash key must not trust
    // that
    // coincidental match — it over-redacts so REAL is scrubbed too (#6097 Codex — decoy collision).
    val values =
      SecretRedactor.secretParameterValues(
        setOf("API\\x54OKEN"),
        mapOf("APITOKEN" to "REAL", "APIx54OKEN" to "DECOY"),
      )
    assertTrue(values.contains("REAL"), "the real (decoded-name) secret value must be scrubbed")
  }

  @Test
  fun `secretParameterValues over-redacts when a declared key cannot be resolved (fail-safe)`() {
    // A hex-escaped key parsed as `APIx54OKEN` matches no parameter by name or normalization, so
    // every
    // parameter value is scrubbed — the secret cannot leak (#6097 fail-safe).
    val values =
      SecretRedactor.secretParameterValues(
        setOf("APIx54OKEN"),
        mapOf("APITOKEN" to "SECRETV", "VIS" to "visible"),
      )
    assertTrue(values.contains("SECRETV"), "the real secret value must be scrubbed")
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

  @Test
  fun `redacts the singly JSON-escaped form of a secret in a tool result`() {
    // The recovery loop's tool/observe results are JSON (issue #6094). A secret with a JSON-special
    // character appears there only in escaped form, which the literal raw value would not match.
    val secret = "pa\"ss\\word\nline"
    val values = SecretRedactor.secretValues(listOf(secret))
    // A singly JSON-encoded result (e.g. iOS's single transport layer).
    val toolResultJson = """{"field":"token pa\"ss\\word\nline"}"""
    assertFalse(
      toolResultJson.contains(secret),
      "precondition: the raw secret is not literally present",
    )
    val result = SecretRedactor.redact(toolResultJson, values)
    assertTrue(
      result.contains(SecretRedactor.PLACEHOLDER),
      "the JSON-escaped secret must be redacted",
    )
    assertFalse(result.contains("""pa\"ss"""), "no escaped-secret fragment may survive")
  }

  @Test
  fun `redacts a secret double-encoded by the Android MCP transport`() {
    // Reproduce DefaultMCPClient's transform (#6094 Codex P1): the observe hierarchy carrying the
    // on-screen secret is a JSON STRING inside content[].text, and `mcpResponse.result.toString()`
    // reserializes the enclosing element, so the secret is DOUBLE-escaped in the string the agent's
    // tools return to the model.
    val secret = "pa\"ss\\word\nline"
    val values = SecretRedactor.secretValues(listOf(secret))
    val hierarchy = buildJsonObject {
      put("node", buildJsonObject { put("value", "token $secret") })
    }
    val envelope = buildJsonObject {
      put(
        "content",
        buildJsonArray {
          add(
            buildJsonObject {
              put("type", "text")
              // The hierarchy JSON as a string value → one encoding layer here …
              put("text", hierarchy.toString())
            }
          )
        },
      )
    }
    // … and serializing the enclosing element re-encodes it → the secret is double-escaped.
    val transportText = envelope.toString()
    assertFalse(
      transportText.contains(secret),
      "precondition: the raw secret is not literally present in the double-encoded transport",
    )
    val result = SecretRedactor.redact(transportText, values)
    assertTrue(
      result.contains(SecretRedactor.PLACEHOLDER),
      "the double-encoded secret must be redacted",
    )
    assertFalse(result.contains("word"), "no double-escaped secret fragment may survive")
  }

  @Test
  fun `a secret that collides with the redaction marker does not survive`() {
    // A secret whose VALUE is the marker (or a substring of it) must not be reintroduced by the
    // replacement — e.g. replacing "REDACTED" with "***REDACTED***" would leave "REDACTED" (#6094).
    for (secret in listOf("REDACTED", "***REDACTED***", "***")) {
      val values = SecretRedactor.secretValues(listOf(secret))
      val result = SecretRedactor.redact("token $secret here", values)
      assertFalse(
        result.contains(secret),
        "the marker-colliding secret \"$secret\" must not survive redaction",
      )
      assertTrue(result.contains("token "), "non-secret context is preserved")
    }
  }

  @Test
  fun `a shorter secret's replacement cannot synthesize a longer secret containing the marker`() {
    // Reverse marker collision (#6146): declared `abc` and `X***REDACTED***Y`, text `XabcY`.
    // Longest-first finds the longer secret nowhere, replaces `abc` with the marker, and the result
    // IS the longer secret — fully present after its only removal opportunity passed.
    val longer = "X${SecretRedactor.PLACEHOLDER}Y"
    val values = SecretRedactor.secretValues(listOf("abc", longer))
    val result = SecretRedactor.redact("XabcY", values)
    assertFalse(result.contains(longer), "the marker-containing secret must not be synthesized")
    assertFalse(result.contains("abc"), "the shorter secret must be redacted")
    assertEquals(SecretRedactor.PLACEHOLDER, result)
  }

  @Test
  fun `a marker-substring secret is not reintroduced by another secret's replacement`() {
    // `REDACTED` is itself a declared secret, so substituting `***REDACTED***` for `abc` would put
    // that declared value in the output verbatim (#6146).
    val values = SecretRedactor.secretValues(listOf("REDACTED", "abc"))
    val result = SecretRedactor.redact("token abc here", values)
    assertFalse(result.contains("REDACTED"), "the marker-substring secret must not survive")
    assertFalse(result.contains("abc"), "the ordinary secret must be redacted")
    assertTrue(result.startsWith("token ") && result.endsWith(" here"), "context is preserved")
  }

  @Test
  fun `a secret equal to the marker is not reintroduced by another secret's replacement`() {
    val values = SecretRedactor.secretValues(listOf(SecretRedactor.PLACEHOLDER, "abc"))
    val result = SecretRedactor.redact("token abc here", values)
    assertFalse(result.contains(SecretRedactor.PLACEHOLDER), "the marker secret must not survive")
    assertFalse(result.contains("abc"), "the ordinary secret must be redacted")
  }

  @Test
  fun `ordinary text is unchanged and an ordinary secret keeps its context`() {
    val values = SecretRedactor.secretValues(listOf("s3cr3t"))
    assertEquals("nothing to see", SecretRedactor.redact("nothing to see", values))
    assertEquals(
      "token ${SecretRedactor.PLACEHOLDER} here",
      SecretRedactor.redact("token s3cr3t here", values),
    )
  }

  @Test
  fun `a replacement chain that does not converge over-redacts the whole text`() {
    // Each pass of `X***REDACTED***` -> marker consumes one leading `X`, so a run of `X`s longer
    // than the pass budget cannot converge in time. The fail-safe is the marker alone —
    // over-redact,
    // never leak (#6146).
    val chained = "X${SecretRedactor.PLACEHOLDER}"
    val values = SecretRedactor.secretValues(listOf("abc", chained))
    val result = SecretRedactor.redact("XXXXXXXXabc", values)
    assertEquals(SecretRedactor.PLACEHOLDER, result)
  }

  @Test
  fun `no declared value survives redaction for a table of adversarial inputs`() {
    val marker = SecretRedactor.PLACEHOLDER
    val cases =
      listOf(
        listOf("abc", "X${marker}Y") to "XabcY",
        listOf("REDACTED", "abc") to "abc",
        listOf(marker, "abc") to "token abc",
        listOf("ab", "abcdef") to "x abcdef y",
        listOf("***", "a") to "a*a*a",
        listOf("X$marker", "abc") to "XXXabc XabcX",
        listOf("$marker$marker", "q") to "qq q",
        listOf("*", "R") to "R*R",
        listOf("é", "café") to "café café",
        listOf("pa\"ss", "\\\"") to "{\"v\":\"pa\\\"ss\"}",
        listOf("s3cr3t") to "nothing to see",
      )
    for ((secrets, text) in cases) {
      val values = SecretRedactor.secretValues(secrets)
      val result = SecretRedactor.redact(text, values)
      for (value in values) {
        assertFalse(
          result.contains(value),
          "declared value \"$value\" survived as \"$result\" for input \"$text\"",
        )
      }
    }
  }
}
