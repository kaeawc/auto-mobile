package dev.jasonpearson.automobile.desktop.core.shell

enum class DesktopPlatform {
  MacOS,
  Windows,
  Linux;

  companion object {
    val current: DesktopPlatform by lazy {
      val os = System.getProperty("os.name")?.lowercase() ?: ""
      when {
        os.contains("mac") -> MacOS
        os.contains("win") -> Windows
        else -> Linux
      }
    }
  }
}
