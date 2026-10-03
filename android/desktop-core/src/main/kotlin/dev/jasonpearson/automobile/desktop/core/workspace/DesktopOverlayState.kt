package dev.jasonpearson.automobile.desktop.core.workspace

/** One active app overlay: a menu request replaces the previous overlay atomically. */
enum class DesktopOverlayState {
  None,
  Settings,
  About;

  fun openAbout(): DesktopOverlayState = About

  fun openSettings(): DesktopOverlayState = Settings

  fun closeAbout(): DesktopOverlayState = if (this == About) None else this

  fun closeSettings(): DesktopOverlayState = if (this == Settings) None else this
}
