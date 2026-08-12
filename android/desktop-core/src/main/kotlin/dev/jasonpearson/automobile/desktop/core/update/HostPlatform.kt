package dev.jasonpearson.automobile.desktop.core.update

/**
 * The host OS, paired with the release-asset filename suffix its installer uses. The release
 * workflow attaches `AutoMobile-<version>-macos.dmg`, `-windows.msi`, and `-linux.deb`, so an asset
 * is resolved by matching [assetSuffix] rather than reconstructing the whole version-dependent
 * name.
 */
enum class HostPlatform(val assetSuffix: String) {
  MAC("-macos.dmg"),
  WINDOWS("-windows.msi"),
  LINUX("-linux.deb");

  companion object {
    /** Detects the current platform, or null for an OS we do not ship an installer for. */
    fun current(osName: String = System.getProperty("os.name") ?: ""): HostPlatform? {
      val normalized = osName.lowercase()
      return when {
        normalized.contains("mac") || normalized.contains("darwin") -> MAC
        normalized.contains("win") -> WINDOWS
        normalized.contains("nux") || normalized.contains("nix") -> LINUX
        else -> null
      }
    }
  }
}
