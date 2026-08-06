package dev.jasonpearson.automobile.desktop.core.workspace

/** Platform of an observed device, with the emoji used in its column-header chip. */
enum class Platform(val emoji: String) {
  Android("🤖"), // 🤖
  Ios("🍎"), // 🍎
}

/** The `platform` string the daemon/MCP tools expect ("android"/"ios"). */
fun Platform.wireName(): String = if (this == Platform.Ios) "ios" else "android"

/** Per-column interaction mode. The header toggle flips between the two (forgiving both ways). */
enum class InteractionMode {
  Input,
  Inspect,
}

/**
 * Per-column device orientation. The workspace tracks this because the `rotate` MCP tool requires
 * an explicit target orientation (∈ {portrait, landscape}) rather than a relative "rotate" verb;
 * the Rotate control toggles this and passes the new value. [toolValue] is the exact string the
 * tool expects.
 */
enum class Orientation(val toolValue: String) {
  Portrait("portrait"),
  Landscape("landscape");

  /** The other orientation — what a single Rotate tap flips to. */
  fun toggled(): Orientation = if (this == Portrait) Landscape else Portrait
}

/**
 * The per-device tools, shown as emoji in the column header. Emoji match the desktop app's sidebar
 * facet vocabulary (see `AutoMobileContent`/`AppIcons`). There is no separate "Bug" tool — bug
 * reporting lives inside [Failures].
 */
enum class Tool(val icon: String, val label: String) {
  Navigation("🧭", "Navigation"), // 🧭
  Logs("📄", "Logs"), // 📄
  Storage("💾", "Storage"), // 💾
  Network("🌐", "Network"), // 🌐
  Test("🧪", "Test"), // 🧪
  Failures("💥", "Failures"), // 💥
  Performance("⚡", "Performance"), // ⚡
}

/**
 * Emulator controls that float on each device stream. These are one-shot device actions: the
 * workspace emits an intent and the host runs it against the device. [Unlock] is contextual — shown
 * only when the column is `locked`. The non-one-shot `locale` (needs a target picker) and `more`
 * (overflow menu) controls are a follow-up.
 */
enum class EmulatorControl(val icon: String, val label: String) {
  Rotate("🔄", "Rotate"), // 🔄
  Screenshot("📸", "Screenshot"), // 📸
  Snapshot("🗂", "Snapshot"), // 🗂
  Unlock("🔓", "Unlock"), // 🔓
}

/** High-level health rollup shown as the single status dot in the top bar. */
enum class WorkspaceStatus {
  Green,
  Yellow,
  Red,
}

/**
 * One observed device rendered as a column. Identity (name + platform) lives here — there is no
 * separate device-tab bar. A device is either observed (present as a column) or not; there is no
 * minimized state.
 */
data class DeviceColumn(
  val deviceId: String,
  val name: String,
  val platform: Platform,
  val mode: InteractionMode = InteractionMode.Input,
  val activeTool: Tool? = null,
  val shrunk: Boolean = false,
  val locked: Boolean = false,
  /** Current orientation; the Rotate control toggles it and drives the `rotate` tool value. */
  val orientation: Orientation = Orientation.Portrait,
)
