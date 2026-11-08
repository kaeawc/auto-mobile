package dev.jasonpearson.automobile.buildlogic.r8

import org.junit.Assert.assertEquals
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
}
