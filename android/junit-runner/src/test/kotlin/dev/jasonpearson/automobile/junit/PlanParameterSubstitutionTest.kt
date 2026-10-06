package dev.jasonpearson.automobile.junit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.SafeConstructor

/**
 * Issue #10093: `${name}` parameters are applied on the parsed YAML tree, so a value arrives at the
 * tool exactly as the test supplied it and can never change the plan's structure. Every test parses
 * the substituted plan with snakeyaml and asserts on the decoded value.
 */
class PlanParameterSubstitutionTest {
  // A literal `$` for raw strings, where `\$` is not an escape.
  private val D = "$"

  // Each value broke the old text splice in at least one quoting context.
  private val hostileValues =
    listOf(
      "C:\\temp#1",
      "Tr\\0ub4dor",
      "pa\\ss",
      "say \"hi\"",
      "it's",
      "shoes #1",
      "size: large",
      "line1\nline2",
      "a\r\nb",
      "tab\there",
      "\${other}",
      "  padded  ",
      " leading",
      "trailing ",
      "Ünï — 日本語 😀",
      "- dash",
      "[bracket]",
      "{brace}",
      "key: value # c",
      "'",
      "\"",
      "\\",
      "%percent @at `tick",
    )

  private fun load(yaml: String): Map<*, *> =
    Yaml(SafeConstructor(LoaderOptions())).load<Any?>(yaml) as Map<*, *>

  private fun step(plan: String, index: Int = 0): Map<*, *> =
    ((load(plan)["steps"] as List<*>)[index]) as Map<*, *>

  private fun substitute(source: String, vararg params: Pair<String, Any>): String =
    PlanParameterSubstitution.substitutePlan(source, mapOf(*params))

  private fun plan(valueSource: String) =
    """
    name: p
    steps:
      - tool: inputText
        text: $valueSource
        label: x
    """
      .trimIndent()

  @Test
  fun `double quoted placeholder delivers every hostile value exactly`() {
    for (value in hostileValues) {
      val out = substitute(plan("\"\${p}\""), "p" to value)
      assertEquals("value `$value`", value, step(out)["text"])
    }
  }

  @Test
  fun `single quoted placeholder delivers every hostile value exactly`() {
    for (value in hostileValues) {
      val out = substitute(plan("'\${p}'"), "p" to value)
      assertEquals("value `$value`", value, step(out)["text"])
    }
  }

  @Test
  fun `unquoted placeholder delivers every non plain-safe value exactly as a string`() {
    // Values YAML would read as a number/boolean/null are covered by the typing tests below.
    for (value in hostileValues) {
      val out = substitute(plan("\${p}"), "p" to value)
      assertEquals("value `$value`", value, step(out)["text"])
    }
  }

  @Test
  fun `placeholder embedded in longer text delivers every hostile value exactly`() {
    for (style in listOf("\"Hi \${p}!\"", "'Hi \${p}!'", "Hi \${p}!")) {
      for (value in hostileValues) {
        val out = substitute(plan(style), "p" to value)
        assertEquals("$style with `$value`", "Hi $value!", step(out)["text"])
      }
    }
  }

  @Test
  fun `block scalar placeholder delivers a multi-line value exactly`() {
    val source =
      """
      name: p
      steps:
        - tool: inputText
          text: |
            before ${D}{p} after
      """
        .trimIndent()
    val out = substitute(source, "p" to "x\n  - tool: terminateApp\nC:\\temp")
    assertEquals("before x\n  - tool: terminateApp\nC:\\temp after", step(out)["text"])
    assertEquals(1, (load(out)["steps"] as List<*>).size)
  }

  @Test
  fun `an empty parameter is an empty string, not null, in every scalar style`() {
    for (style in listOf("\"\${p}\"", "\${p}", "'\${p}'")) {
      val text = step(substitute(plan(style), "p" to ""))
      assertTrue(style, text.containsKey("text"))
      assertEquals(style, "", text["text"])
    }
  }

  @Test
  fun `a value cannot add steps or keys to the plan`() {
    val injected = "a\n  - tool: terminateApp\n    appId: evil"
    for (style in listOf("\"\${p}\"", "\${p}", "'\${p}'")) {
      val out = substitute(plan(style), "p" to injected)
      assertEquals(style, 1, (load(out)["steps"] as List<*>).size)
      assertEquals(style, injected, step(out)["text"])
      assertEquals(style, setOf("tool", "text", "label"), step(out).keys)
    }
  }

  @Test
  fun `a substituted value is not expanded again whatever the key order`() {
    val params = arrayOf<Pair<String, Any>>("a" to "\${b}", "b" to "x")
    val out = substitute(plan("\"\${a}-\${b}\""), *params)
    assertEquals("\${b}-x", step(out)["text"])

    val reversed = substitute(plan("\"\${b}-\${a}\""), *params)
    assertEquals("x-\${b}", step(reversed)["text"])
  }

  @Test
  fun `substituteText is a single pass and leaves unknown placeholders literal`() {
    val params = mapOf<String, Any>("a" to "\${b}", "b" to "x")
    assertEquals(
      "\${b}|x|\${nope}",
      PlanParameterSubstitution.substituteText("\${a}|\${b}|\${nope}", params),
    )
    assertEquals("same", PlanParameterSubstitution.substituteText("same", emptyMap()))
  }

  @Test
  fun `unquoted whole-scalar placeholder keeps the value's YAML plain type`() {
    // Matches the old splice for values that used to work: numeric/boolean tool arguments.
    assertEquals(500, step(substitute(plan("\${p}"), "p" to 500))["text"])
    assertEquals(true, step(substitute(plan("\${p}"), "p" to true))["text"])
    assertEquals(2.5, step(substitute(plan("\${p}"), "p" to 2.5))["text"])
    assertEquals(500, step(substitute(plan("\${p}"), "p" to "500"))["text"])
    assertEquals(false, step(substitute(plan("\${p}"), "p" to "false"))["text"])
    assertEquals("hunter2", step(substitute(plan("\${p}"), "p" to "hunter2"))["text"])
  }

  @Test
  fun `quoted or embedded placeholder is always a string`() {
    assertEquals("12345", step(substitute(plan("\"\${p}\""), "p" to "12345"))["text"])
    assertEquals("12345", step(substitute(plan("\"\${p}\""), "p" to 12345))["text"])
    assertEquals("true", step(substitute(plan("'\${p}'"), "p" to true))["text"])
    assertEquals("x500", step(substitute(plan("x\${p}"), "p" to 500))["text"])
  }

  @Test
  fun `placeholder works inside flow collections and as a mapping key`() {
    val source =
      """
      name: p
      secretParameters: [${D}{a}, ${D}{b}]
      steps:
        - tool: tapOn
          ${D}{k}: v
      """
        .trimIndent()
    val out = substitute(source, "a" to "A,]", "b" to "B", "k" to "key: x")
    assertEquals(listOf("A,]", "B"), load(out)["secretParameters"])
    assertEquals("v", step(out)["key: x"])
  }

  @Test
  fun `unrelated scalars keep their types and unknown placeholders stay literal`() {
    val source =
      """
      name: p
      steps:
        - tool: observe
          timeout: 20000
          enabled: true
          nothing: null
          ratio: 1.5
          since: 2024-01-02
          hex: 0x1F
          note: "keep ${D}{unknown}"
          text: "${D}{p}"
          nested:
            list: [1, "two", false]
      """
        .trimIndent()
    val original = step(substitute(source, "zzz" to "unused"))
    val out = step(substitute(source, "p" to "v"))
    for ((key, value) in original) {
      if (key != "text") assertEquals("key $key", value, out[key])
    }
    assertEquals("v", out["text"])
    assertEquals("keep \${unknown}", out["note"])
    assertEquals(20000, out["timeout"])
    assertEquals(true, out["enabled"])
  }

  @Test
  fun `placeholder in a comment cannot affect the plan`() {
    val source = "name: p # \${p}\nsteps:\n  - tool: inputText\n    text: \"\${p}\" # \${p}\n"
    val out = substitute(source, "p" to "a\n  - tool: terminateApp")
    assertEquals(1, (load(out)["steps"] as List<*>).size)
    assertEquals("a\n  - tool: terminateApp", step(out)["text"])
  }

  @Test
  fun `plan without a known placeholder is returned byte for byte`() {
    val source = "name: p\nsteps:\n  - tool: inputText # c\n    text:   'x'\n"
    assertEquals(source, substitute(source, "other" to "v"))
    assertEquals(source, PlanParameterSubstitution.substitutePlan(source, emptyMap()))
  }

  @Test
  fun `uncomposable plan is returned unchanged for the validator to report`() {
    val source = "name: [unterminated \${p}\n"
    assertEquals(source, substitute(source, "p" to "v"))
  }

  @Test
  fun `a sentinel-like string already in the plan is not mistaken for a placeholder`() {
    val source = plan("\"AMxPARAMx0x \${p}\"")
    assertEquals("AMxPARAMx0x v", step(substitute(source, "p" to "v"))["text"])
  }

  @Test
  fun `the serialized plan keeps a secret redactable in every hostile form`() {
    for (value in hostileValues.filter { it.isNotBlank() }) {
      val out = substitute(plan("\${p}"), "p" to value)
      val redacted = SecretRedactor.redact(out, SecretRedactor.secretValues(listOf(value)))
      assertFalse("`$value` leaked in:\n$redacted", redacted.contains(value))
    }
  }

  @Test
  fun `typed plain value stays visible so it is still redactable`() {
    val out = substitute(plan("\${p}"), "p" to 123456)
    assertTrue(out.contains("123456"))
  }
}
