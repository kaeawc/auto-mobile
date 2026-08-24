package dev.jasonpearson.automobile.desktop.core.settings

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
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
        // Parse into a throwaway Properties first and adopt it only after the WHOLE file loaded:
        // Properties.load can populate earlier entries and then throw on a malformed/truncated
        // line,
        // which would otherwise leave `props` as an order-dependent mix of persisted values and
        // defaults. A failed parse leaves clean defaults instead.
        val loaded = Properties()
        file.inputStream().use { loaded.load(it) }
        props.putAll(loaded)
      }
    } catch (error: Exception) {
      // Best-effort: an unreadable settings file leaves defaults in place rather than crashing.
      LOG.warn("Failed to read desktop settings from ${file.path}: ${error.message}", error)
    }
  }

  private fun save() {
    try {
      val dir = file.parentFile ?: File(".")
      dir.mkdirs()
      // Write to a temp file in the SAME directory and atomically replace the target, so a crash or
      // disk-full mid-write can never leave the canonical file truncated — which would blank
      // hasSeenOnboarding and re-show onboarding on the next launch. Same dir keeps the move on one
      // filesystem so ATOMIC_MOVE applies.
      val tmp = File.createTempFile("desktop-settings", ".tmp", dir)
      try {
        tmp.outputStream().use { props.store(it, "AutoMobile desktop settings") }
        try {
          Files.move(
            tmp.toPath(),
            file.toPath(),
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING,
          )
        } catch (atomicUnsupported: AtomicMoveNotSupportedException) {
          // Rare filesystem without atomic rename: a plain replace is still safer than truncating
          // the target in place, and the fully-written temp is the source either way.
          LOG.debug("Atomic settings move unsupported, falling back to replace: $atomicUnsupported")
          Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
      } finally {
        tmp.delete() // no-op once the move has consumed it; cleans up if the write/move threw
      }
    } catch (error: Exception) {
      // Best-effort: a failed write keeps the value in memory for this session (the previous file
      // survives intact); the next set retries.
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

  override var streamQualityPreset: String
    get() = string(KEY_STREAM_QUALITY_PRESET, "medium")
    set(value) = put(KEY_STREAM_QUALITY_PRESET, value)

  override var streamQualityAutoAdjust: Boolean
    get() = boolean(KEY_STREAM_QUALITY_AUTO_ADJUST, true)
    set(value) = put(KEY_STREAM_QUALITY_AUTO_ADJUST, value)

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
    private const val KEY_STREAM_QUALITY_PRESET = "streamQualityPreset"
    private const val KEY_STREAM_QUALITY_AUTO_ADJUST = "streamQualityAutoAdjust"

    /** Resolves `~/.auto-mobile/desktop-settings.properties`, matching `AutoMobileSocketPaths`. */
    fun defaultSettingsFile(): File {
      // Falling back to "." keeps this relative rather than interpolating "null" on the rare JVM
      // where user.home is unset (mirrors AutoMobileSocketPaths).
      val home = System.getProperty("user.home", "").ifBlank { "." }
      return File(home, "$SETTINGS_DIR/$SETTINGS_FILE")
    }
  }
}
