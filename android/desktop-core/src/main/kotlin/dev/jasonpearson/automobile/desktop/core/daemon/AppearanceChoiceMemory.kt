package dev.jasonpearson.automobile.desktop.core.daemon

/**
 * The appearance the user last chose in this desktop run, kept apart from any daemon session
 * (#11363, owner decision 2026-10-10). The daemon stores a choice per session and drops it when the
 * session is released for good, so every rotation (idle release, a host hidden past its grace, a
 * device switch, a lost device) would fall back to the global default. The desktop session re-sends
 * [lastChoice] under each session it registers.
 */
class AppearanceChoiceMemory {
  @Volatile
  var lastChoice: AppearanceSyncMode? = null
    private set

  /**
   * Records the choice a successful appearance call left the session's config at. Host sync off
   * with an `auto` default is no choice `set_appearance` can send again, so it forgets the last.
   */
  fun remember(config: AppearanceConfig) {
    lastChoice =
      when {
        config.syncWithHost -> AppearanceSyncMode.Auto
        config.defaultMode == AppearanceSyncMode.Auto.wireName -> null
        else -> AppearanceSyncMode.fromWireName(config.defaultMode)
      }
  }
}

/**
 * An [AppearanceClient] that records each choice the user makes in [memory], so it survives the
 * session it was made under (#11363). Reads pass through untouched.
 */
class RememberingAppearanceClient(
  private val delegate: AppearanceClient,
  private val memory: AppearanceChoiceMemory,
) : AppearanceClient by delegate {

  override fun setSyncWithHost(enabled: Boolean): AppearanceResult =
    delegate.setSyncWithHost(enabled).also { memory.remember(it.config) }

  override fun setMode(mode: AppearanceSyncMode): AppearanceResult =
    delegate.setMode(mode).also { memory.remember(it.config) }
}
