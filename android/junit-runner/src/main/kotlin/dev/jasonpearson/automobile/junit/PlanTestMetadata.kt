package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test

internal object PlanTestMetadata {
  /** Detected test context from stack trace inspection. */
  internal data class TestContext(val className: String, val methodName: String)

  /**
   * Detect the calling test class and method from the current stack trace. Looks for methods
   * annotated with @Test by inspecting the call stack.
   */
  internal fun detectTestContext(): TestContext? {
    val stackTrace = Thread.currentThread().stackTrace

    for (element in stackTrace) {
      // Skip internal classes
      if (isInternalFrame(element)) continue

      try {
        val clazz = Class.forName(element.className)
        val methods = clazz.declaredMethods

        for (method in methods) {
          if (method.name == element.methodName && method.isAnnotationPresent(Test::class.java)) {
            // Found a @Test annotated method in the call stack
            // Fully qualified: two `SmokeTest` classes in different packages must not share one
            // (test_class, test_method) history (#10091).
            return TestContext(clazz.name, method.name)
          }
        }
      } catch (_: ClassNotFoundException) {
        // Class not found, skip
      } catch (_: NoClassDefFoundError) {
        // Class definition error, skip
      }
    }

    return null
  }

  /** Build test metadata JSON object for the daemon request. */
  internal fun buildTestMetadata(testContext: TestContext): JsonObject {
    val metadata =
      mutableMapOf<String, JsonElement>(
        "testClass" to JsonPrimitive(testContext.className),
        "testMethod" to JsonPrimitive(testContext.methodName),
        "isCi" to JsonPrimitive(resolveCiMode()),
      )

    appendApplicationMetadata(metadata)
    appendRuntimeMetadata(metadata)
    return JsonObject(metadata)
  }

  private fun appendApplicationMetadata(metadata: MutableMap<String, JsonElement>) {
    // Add optional metadata if available
    val appVersion =
      firstNonBlank(
        System.getProperty("automobile.app.version", ""),
        System.getenv("AUTOMOBILE_APP_VERSION"),
        System.getenv("APP_VERSION"),
      )
    if (appVersion != null) {
      metadata["appVersion"] = JsonPrimitive(appVersion)
    }

    val gitCommit =
      firstNonBlank(
        System.getProperty("automobile.git.commit", ""),
        System.getenv("AUTOMOBILE_GIT_COMMIT"),
        System.getenv("GITHUB_SHA"),
        System.getenv("GIT_COMMIT"),
        System.getenv("CI_COMMIT_SHA"),
      )
    if (gitCommit != null) {
      metadata["gitCommit"] = JsonPrimitive(gitCommit)
    }
  }

  private fun appendRuntimeMetadata(metadata: MutableMap<String, JsonElement>) {
    val targetSdk =
      firstNonBlank(
          System.getProperty("automobile.android.targetSdk", ""),
          System.getProperty("automobile.targetSdk", ""),
          System.getenv("AUTOMOBILE_TARGET_SDK"),
          System.getenv("ANDROID_TARGET_SDK"),
        )
        ?.toIntOrNull()
    if (targetSdk != null) {
      metadata["targetSdk"] = JsonPrimitive(targetSdk)
    }

    val jdkVersion =
      firstNonBlank(
        System.getProperty("java.version"),
        System.getProperty("java.runtime.version"),
      )
    if (jdkVersion != null) {
      metadata["jdkVersion"] = JsonPrimitive(jdkVersion)
    }

    val jvmTarget =
      firstNonBlank(
        System.getProperty("kotlin.jvm.target"),
        System.getProperty("java.specification.version"),
      )
    if (jvmTarget != null) {
      metadata["jvmTarget"] = JsonPrimitive(jvmTarget)
    }

    val gradleVersion =
      firstNonBlank(
        System.getProperty("org.gradle.version"),
        System.getProperty("gradle.version"),
      )
    if (gradleVersion != null) {
      metadata["gradleVersion"] = JsonPrimitive(gradleVersion)
    }
  }

  private fun isInternalFrame(element: StackTraceElement): Boolean =
    listOf("java.", "kotlin.", "jdk.", "sun.").any(element.className::startsWith) ||
      element.className.contains("AutoMobilePlan")

  internal fun resolveCiMode(): Boolean {
    val sysProp = System.getProperty("automobile.ci.mode")
    if (sysProp != null) {
      // Explicit system property takes precedence over environment
      return sysProp.toBoolean()
    }
    val envValue = System.getenv("CI") ?: return false
    return envValue.equals("true", ignoreCase = true) || envValue == "1"
  }

  private fun firstNonBlank(vararg values: String?): String? {
    return values.firstOrNull { !it.isNullOrBlank() }
  }
}
