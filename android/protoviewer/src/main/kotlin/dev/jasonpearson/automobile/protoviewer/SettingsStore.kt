package dev.jasonpearson.automobile.protoviewer

import android.content.SharedPreferences
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Shared by every document task; reads at request time also see changes from the library. */
interface SettingsStore {
  val allowNetwork: StateFlow<Boolean>

  /** Monotonic revocation epoch: StateFlow conflation must not hide a quick off/on cycle. */
  val networkRevocations: StateFlow<Long>

  fun setAllowNetwork(enabled: Boolean)
}

class SharedPreferencesSettingsStore(private val preferences: SharedPreferences) : SettingsStore {
  private val network = MutableStateFlow(preferences.getBoolean(ALLOW_NETWORK, false))
  override val allowNetwork = network.asStateFlow()
  private val revocations = MutableStateFlow(0L)
  override val networkRevocations = revocations.asStateFlow()

  @Synchronized
  override fun setAllowNetwork(enabled: Boolean) {
    // apply updates memory immediately and serializes disk writes off the main thread.
    preferences.edit { putBoolean(ALLOW_NETWORK, enabled) }
    if (!enabled && network.value) revocations.value++
    network.value = enabled
  }

  private companion object {
    const val ALLOW_NETWORK = "allow_imported_prototype_network"
  }
}
