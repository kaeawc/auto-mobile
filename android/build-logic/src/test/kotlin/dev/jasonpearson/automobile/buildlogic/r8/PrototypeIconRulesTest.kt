package dev.jasonpearson.automobile.buildlogic.r8

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeIconRulesTest {
  private fun contract(values: String, kind: String = "enum"): String =
    """{"definitions":{"iconName":{"kind":"$kind","values":$values}}}"""

  @Test
  fun generatesOnlyContractGettersInAllFiveStyles() {
    val names = PrototypeIconRules.names(contract("""["alarm_add","home","alarm_add"]"""))
    assertEquals(listOf("alarm_add", "home"), names)
    val rules =
      PrototypeIconRules.rules(names).lineSequence().filter { it.startsWith("-keep") }.toList()
    assertEquals(10, rules.size)
    for (style in PrototypeIconRules.styles) {
      assertTrue(
        "-keep class androidx.compose.material.icons.$style.AlarmAddKt { public static *** getAlarmAdd(...); }" in
          rules,
      )
      assertTrue(
        "-keep class androidx.compose.material.icons.$style.HomeKt { public static *** getHome(...); }" in
          rules,
      )
    }
  }

  @Test
  fun rejectsMissingEmptyMalformedOrNonStringEnums() {
    for (input in
      listOf(
        "{",
        "{}",
        contract("[]"),
        contract("[1]"),
        contract("[null]"),
        contract("[home]"),
        contract("[\"Home\"]"),
        contract("[\"home\"]", "string"),
      )) {
      assertThrows(RuntimeException::class.java) { PrototypeIconRules.names(input) }
    }
  }

  @Test
  fun enforcesRuntimeNameGrammarAndPascalDerivation() {
    assertEquals("ExposureNeg1", PrototypeIconRules.pascal("exposure_neg_1"))
    assertEquals("ThreeDRotation", PrototypeIconRules.pascal("three_d_rotation"))
    for (name in
      listOf("", "Home", "_home", "home_", "home__add", "3d_rotation", "home-add", "home\n")) {
      assertThrows(IllegalArgumentException::class.java) { PrototypeIconRules.pascal(name) }
    }
  }
}
