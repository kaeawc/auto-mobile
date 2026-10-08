package dev.jasonpearson.automobile.sdk

import dev.jasonpearson.automobile.buildlogic.api.SdkApiSignature
import java.io.ByteArrayOutputStream
import java.io.File
import javax.tools.ToolProvider
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import org.junit.BeforeClass
import org.junit.ClassRule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SdkApiSignatureTest {
  @Test
  fun `changing a public string constant changes the signature`() {
    assertContains(originalConstants, "ACTION = \"a\"")
    assertContains(changedStringConstants, "ACTION = \"b\"")
    assertNotEquals(originalConstants, changedStringConstants)
  }

  @Test
  fun `changing a public int constant changes the signature`() {
    assertContains(originalConstants, "COUNT = 1")
    assertContains(changedIntConstants, "COUNT = 2")
    assertNotEquals(originalConstants, changedIntConstants)
  }

  @Test
  fun `private nested classes and their public members are excluded`() {
    assertTrue(File(nestedClasses, "Outer\$Entry.class").isFile)
    assertContains(nestedSignature, "public class Outer {")
    assertFalse(nestedSignature.contains("Outer\$Entry"))
    assertFalse(nestedSignature.contains("entryOnly"))
  }

  @Test
  fun `public nested declarations survive while private siblings are removed`() {
    assertContains(nestedSignature, "public class Outer\$Inner {")
    assertContains(nestedSignature, "innerOnly()")
    assertContains(nestedSignature, "public class Outer\$Inner\$Deep {")
    assertContains(nestedSignature, "deepOnly()")
    // Pair inclusion with exclusion: the old unfiltered dump also included public classes.
    assertFalse(nestedSignature.contains("Outer\$Entry"))
    assertTrue(nestedSignature.endsWith("}\n"))
    assertFalse(nestedSignature.endsWith("\n\n"))
  }

  @Test
  fun `anonymous classes including nested lambda style names are excluded`() {
    assertTrue(File(nestedClasses, "Outer\$1.class").isFile)
    assertTrue(File(nestedClasses, "Outer\$Factory\$1.class").isFile)
    assertTrue(File(nestedClasses, "Outer\$Generated\$1.class").isFile)
    assertFalse(nestedSignature.contains("Outer\$1"))
    assertFalse(nestedSignature.contains("Outer\$Factory\$1"))
    assertFalse(nestedSignature.contains("Outer\$Generated\$1"))
    assertFalse(nestedSignature.contains("generatedOnly"))
    assertContains(nestedSignature, "public class Outer\$Factory {")
    assertContains(nestedSignature, "public class Outer\$Generated {")
  }

  @Test
  fun `public nested classes require every enclosing declaration to be public`() {
    assertTrue(File(nestedClasses, "Hidden\$Inner\$Leaf.class").isFile)
    assertFalse(nestedSignature.contains("class Hidden"))
    assertFalse(nestedSignature.contains("Hidden\$Inner"))
    assertContains(nestedSignature, "public class Outer {")
  }

  companion object {
    @ClassRule @JvmField val temporaryFolder = TemporaryFolder()

    private lateinit var originalConstants: String
    private lateinit var changedStringConstants: String
    private lateinit var changedIntConstants: String
    private lateinit var nestedClasses: File
    private lateinit var nestedSignature: String

    // Compiler and javap integration belongs in class setup so test bodies stay under 100ms.
    @BeforeClass
    @JvmStatic
    fun compileSignatures() {
      val javap = File(System.getProperty("java.home"), "bin/javap").path
      val generator = SdkApiSignature(javap)
      originalConstants = generator.generate(listOf(compileConstants("original", "a", 1)))
      changedStringConstants = generator.generate(listOf(compileConstants("string", "b", 1)))
      changedIntConstants = generator.generate(listOf(compileConstants("int", "a", 2)))
      nestedClasses =
        compileJava(
          "nested",
          "Outer",
          """
          public class Outer {
            private static class Entry {
              public Entry(String s) {}
              public void entryOnly() {}
            }
            public static class Inner {
              public void innerOnly() {}
              public static class Deep { public void deepOnly() {} }
            }
            public Runnable anonymous() {
              return new Runnable() { public void run() {} };
            }
            public static class Factory {
              public Runnable task() {
                return new Runnable() { public void run() {} };
              }
            }
            public static class Generated {}
          }
          class Hidden {
            public static class Inner {
              public static class Leaf { public void hiddenOnly() {} }
            }
          }
          """
            .trimIndent(),
          // A public declaration with a numeric suffix exercises name filtering independently
          // of visibility, like Kotlin's public compiler-generated Runnable classes.
          mapOf(
            "Outer\$Generated\$1" to
              "public final class Outer\$Generated\$1 { public void generatedOnly() {} }",
          ),
        )
      nestedSignature = generator.generate(listOf(nestedClasses))
    }

    private fun compileConstants(directory: String, action: String, count: Int): File =
      compileJava(
        directory,
        "Constants",
        """
        public class Constants {
          public static final String ACTION = "$action";
          public static final int COUNT = $count;
        }
        """
          .trimIndent(),
      )

    private fun compileJava(
      directory: String,
      className: String,
      source: String,
      extraSources: Map<String, String> = emptyMap(),
    ): File {
      val root = temporaryFolder.newFolder(directory)
      val sourceFiles =
        (mapOf(className to source) + extraSources).map { (name, text) ->
          File(root, "$name.java").apply { writeText(text) }
        }
      val classes = File(root, "classes").apply { mkdirs() }
      val compiler = checkNotNull(ToolProvider.getSystemJavaCompiler()) { "Tests require a JDK" }
      val diagnostics = ByteArrayOutputStream()
      val exitCode =
        compiler.run(
          null,
          diagnostics,
          diagnostics,
          "-d",
          classes.path,
          *sourceFiles.map { it.path }.toTypedArray(),
        )
      assertEquals(0, exitCode, "Java fixture compilation failed: $diagnostics")
      return classes
    }
  }
}
