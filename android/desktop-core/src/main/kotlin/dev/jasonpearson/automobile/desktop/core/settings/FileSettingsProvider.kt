package dev.jasonpearson.automobile.desktop.core.settings

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.io.File
import java.util.Properties

private val LOG = LoggerFactory.getLogger("FileSettingsProvider")

/**
 * Persistent [SettingsProvider] backed by a Java properties file under `~/.auto-mobile/`.
 *
 * The desktop app previously wired the in-memory [FakeSettingsProvider], so `hasSeenOnboarding`
 * (and every other setting) reset on each launch and first-run onboarding showed every time. This
 * implementation loads once on construction and writes through on every set, so the onboarding gate
 * — and `themeMode`, IDE prefs, etc. — survive restarts.
 *
 * Persistence is best-effort: an unreadable/unwritable settings file must never crash the app, so a
 * failed load falls back to defaults and a failed save keeps the value in memory for the session.
 * Both are logged at `warn` (unexpected IO), never swallowed silently.
 *
 * [file] is injectable so tests can point at a temp path instead of the real `~/.auto-mobile/`
 * file.
 */
class FileSettingsProvider(private val file: File = defaultSettingsFile()) : SettingsProvider {

  private val props = Properties()

  init {
    load()
  }

  private fun load() {
    try {
      if (file.exists()) {
        file.inputStream().use { props.load(it) }
      }
    } catch (error: Exception) {
      // Best-effort: an unreadable settings file leaves defaults in place rather than crashing.
      LOG.warn("Failed to read desktop settings from ${file.path}: ${error.message}", error)
    }
  }

  private fun save() {
    try {
      file.parentFile?.mkdirs()
      file.outputStream().use { props.store(it, "AutoMobile desktop settings") }
    } catch (error: Exception) {
      // Best-effort: a failed write keeps the value in memory for this session; the next set
      // retries.
      LOG.warn("Failed to persist desktop settings to ${file.path}: ${error.message}", error)
    }
  }

  private fun string(key: String, default: String): String = props.getProperty(key) ?: default

  private fun boolean(key: String, default: Boolean): Boolean =
    props.getProperty(key)?.toBooleanStrictOrNull() ?: default

  private fun put(key: String, value: String) {
    props.setProperty(key, value)
    save()
  }

  private fun put(key: String, value: Boolean) = put(key, value.toString())

  override var enableYamlLinting: Boolean
    get() = boolean(KEY_ENABLE_YAML_LINTING, true)
    set(value) = put(KEY_ENABLE_YAML_LINTING, value)

  override var testPlanOutputDirectory: String
    get() = string(KEY_TEST_PLAN_OUTPUT_DIRECTORY, "test/resources/test-plans")
    set(value) = put(KEY_TEST_PLAN_OUTPUT_DIRECTORY, value)

  override var fogModeEnabled: Boolean
    get() = boolean(KEY_FOG_MODE_ENABLED, true)
    set(value) = put(KEY_FOG_MODE_ENABLED, value)

  override var autoFocusEnabled: Boolean
    get() = boolean(KEY_AUTO_FOCUS_ENABLED, true)
    set(value) = put(KEY_AUTO_FOCUS_ENABLED, value)

  override var failuresDateRange: String
    get() = string(KEY_FAILURES_DATE_RANGE, "24h")
    set(value) = put(KEY_FAILURES_DATE_RANGE, value)

  override var androidIde: String
    get() = string(KEY_ANDROID_IDE, "auto")
    set(value) = put(KEY_ANDROID_IDE, value)

  override var iosIde: String
    get() = string(KEY_IOS_IDE, "auto")
    set(value) = put(KEY_IOS_IDE, value)

  override var themeMode: String
    get() = string(KEY_THEME_MODE, "dark")
    set(value) = put(KEY_THEME_MODE, value)

  override var hasSeenOnboarding: Boolean
    get() = boolean(KEY_HAS_SEEN_ONBOARDING, false)
    set(value) = put(KEY_HAS_SEEN_ONBOARDING, value)

  companion object {
    private const val SETTINGS_DIR = ".auto-mobile"
    private const val SETTINGS_FILE = "desktop-settings.properties"

    private const val KEY_ENABLE_YAML_LINTING = "enableYamlLinting"
    private const val KEY_TEST_PLAN_OUTPUT_DIRECTORY = "testPlanOutputDirectory"
    private const val KEY_FOG_MODE_ENABLED = "fogModeEnabled"
    private const val KEY_AUTO_FOCUS_ENABLED = "autoFocusEnabled"
    private const val KEY_FAILURES_DATE_RANGE = "failuresDateRange"
    private const val KEY_ANDROID_IDE = "androidIde"
    private const val KEY_IOS_IDE = "iosIde"
    private const val KEY_THEME_MODE = "themeMode"
    private const val KEY_HAS_SEEN_ONBOARDING = "hasSeenOnboarding"

    /** Resolves `~/.auto-mobile/desktop-settings.properties`, matching `AutoMobileSocketPaths`. */
    fun defaultSettingsFile(): File {
      // Falling back to "." keeps this relative rather than interpolating "null" on the rare JVM
      // where user.home is unset (mirrors AutoMobileSocketPaths).
      val home = System.getProperty("user.home", "").ifBlank { "." }
      return File(home, "$SETTINGS_DIR/$SETTINGS_FILE")
    }
  }
}
