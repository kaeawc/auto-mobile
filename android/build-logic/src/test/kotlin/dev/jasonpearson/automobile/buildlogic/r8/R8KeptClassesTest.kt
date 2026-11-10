package dev.jasonpearson.automobile.buildlogic.r8

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.objectweb.asm.ClassWriter
import org.objectweb.asm.Opcodes

class R8KeptClassesTest {
  private val manifest =
    """
    <manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example">
      <application android:name=".App">
        <activity android:name=".MainActivity" />
      </application>
    </manifest>
    """
      .trimIndent()

  private fun classBytes(name: String, serializable: Boolean = false): ByteArray {
    val writer = ClassWriter(0)
    writer.visit(Opcodes.V17, Opcodes.ACC_PUBLIC, name, null, "java/lang/Object", null)
    if (serializable) {
      writer.visitAnnotation("Lkotlinx/serialization/Serializable;", true).visitEnd()
    }
    writer.visitEnd()
    return writer.toByteArray()
  }

  private val classes =
    sequenceOf(
      classBytes("com/example/App"),
      classBytes("com/example/MainActivity"),
      classBytes("com/example/Model", serializable = true),
      classBytes("com/example/Model\$\$serializer"),
    )

  private fun analyze(mapping: String) =
    R8KeptClasses.analyze(
      mapping.lineSequence(),
      manifest,
      "com.example",
      classes,
      listOf("com/example/"),
      listOf("com.example.App#onCreate"),
    )

  @Test
  fun passesWhenCheckedNamesSurviveAndIgnoresUncheckedMappings() {
    val result =
      analyze(
        """
        # compiler: R8
        com.example.App -> com.example.App:
            1:2:void onCreate():10:11 -> onCreate
        com.example.MainActivity -> com.example.MainActivity:
        com.example.Model -> com.example.Model:
        com.example.Model${'$'}${'$'}serializer -> com.example.Model${'$'}${'$'}serializer:
        com.example.Unrelated -> a.b:
            void onCreate() -> c
        """
          .trimIndent(),
      )
    assertEquals(emptyList<String>(), result.violations)
  }

  @Test
  fun reportsRenamedAndRemovedCheckedNames() {
    val result =
      analyze(
        """
        com.example.App -> com.example.App:
            void onCreate() -> a
        com.example.MainActivity -> a.b:
        com.example.Model -> com.example.Model:
        """
          .trimIndent(),
      )
    assertEquals(
      listOf(
        "manifest component com.example.MainActivity: renamed to a.b",
        "reflective member com.example.App#onCreate: renamed to a",
        "serializer com.example.Model\$\$serializer: removed",
      ),
      result.violations,
    )
  }

  private val baseMapping =
    """
    com.example.App -> com.example.App:
    com.example.MainActivity -> com.example.MainActivity:
    com.example.Model -> com.example.Model:
    com.example.Model${'$'}${'$'}serializer -> com.example.Model${'$'}${'$'}serializer:
    """
      .trimIndent()

  private fun analyzeIcons(mapping: String, styles: List<String> = PrototypeIconRules.styles) =
    R8KeptClasses.analyze(
      (baseMapping + "\n" + mapping).lineSequence(),
      manifest,
      "com.example",
      classes +
        styles.asSequence().map { classBytes("androidx/compose/material/icons/$it/AlarmAddKt") },
      listOf("com/example/"),
      emptyList(),
      iconNames = listOf("alarm_add"),
    )

  private fun iconMapping(
    style: String,
    finalClass: String = "androidx.compose.material.icons.$style.AlarmAddKt",
    finalGetter: String = "getAlarmAdd",
  ) =
    """
    androidx.compose.material.icons.$style.AlarmAddKt -> $finalClass:
        androidx.compose.ui.graphics.vector.ImageVector getAlarmAdd(androidx.compose.material.icons.Icons${'$'}Filled) -> $finalGetter
    """
      .trimIndent()

  @Test
  fun requiresEveryBundledStyleAndGetter() {
    val result = analyzeIcons(PrototypeIconRules.styles.joinToString("\n") { iconMapping(it) })
    assertEquals(emptyList<String>(), result.violations)
    assertEquals(5, result.sentinels.size)
  }

  @Test
  fun absentAlternateStyleCanFallBackToFilled() {
    val result = analyzeIcons(iconMapping("filled"), listOf("filled"))
    assertEquals(emptyList<String>(), result.violations)
    assertEquals(1, result.sentinels.size)
  }

  @Test
  fun missingFilledFailsEvenWhenAbsentFromInputs() {
    val result = analyzeIcons("", emptyList())
    assertEquals(
      listOf(
        "reflective member androidx.compose.material.icons.filled.AlarmAddKt#getAlarmAdd: removed",
      ),
      result.violations,
    )
  }

  @Test
  fun detectsRemovedAndRenamedAlternateClassesAndGetters() {
    val result =
      analyzeIcons(
        iconMapping("filled") +
          "\n" +
          iconMapping("outlined", finalGetter = "a") +
          "\n" +
          iconMapping("rounded", finalClass = "a.b") +
          "\n" +
          "androidx.compose.material.icons.sharp.AlarmAddKt -> androidx.compose.material.icons.sharp.AlarmAddKt:\n" +
          iconMapping(
            "twotone",
            finalClass = "R8${'$'}${'$'}REMOVED${'$'}${'$'}CLASS${'$'}${'$'}0",
          ),
      )
    assertEquals(4, result.violations.size)
    assertTrue(result.violations.any { it.contains("outlined") && it.endsWith("renamed to a") })
    assertTrue(result.violations.any { it.contains("rounded") && it.contains("renamed to a.b") })
    assertTrue(result.violations.any { it.contains("sharp") && it.endsWith("removed") })
    assertTrue(result.violations.any { it.contains("twotone") && it.endsWith("removed") })
    val removed = analyzeIcons(iconMapping("filled"), listOf("filled", "sharp"))
    assertEquals(
      listOf(
        "reflective member androidx.compose.material.icons.sharp.AlarmAddKt#getAlarmAdd: removed",
      ),
      removed.violations,
    )
  }
}
