package dev.jasonpearson.automobile.desktop.core.workspace

/** Platform of an observed device, with the emoji used in its column-header chip. */
enum class Platform(val emoji: String) {
  Android("🤖"), // 🤖
  Ios("🍎"), // 🍎
}

/** Per-column interaction mode. The header toggle flips between the two (forgiving both ways). */
enum class InteractionMode {
  Input,
  Inspect,
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
)
