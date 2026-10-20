package dev.jasonpearson.automobile.settings

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import dev.jasonpearson.automobile.experimentation.Experiment
import dev.jasonpearson.automobile.experimentation.ExperimentRepository
import dev.jasonpearson.automobile.experimentation.Treatment
import dev.jasonpearson.automobile.storage.AnalyticsRepository
import dev.jasonpearson.automobile.storage.UserRepository
import dev.jasonpearson.automobile.storage.UserStats
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class SettingsViewModel
private constructor(
  private val experimentRepository: ExperimentRepository,
  private val userRepository: UserRepository,
  private val analyticsRepository: AnalyticsRepository,
  private val profile: SettingsProfileState,
) : ViewModel(), SettingsProfile by profile {
  constructor(
    experimentRepository: ExperimentRepository,
    userRepository: UserRepository,
    analyticsRepository: AnalyticsRepository,
  ) : this(
    experimentRepository,
    userRepository,
    analyticsRepository,
    SettingsProfileState(userRepository),
  )

  private val _experiments = MutableStateFlow<List<Experiment<*>>>(emptyList())
  val experiments: StateFlow<List<Experiment<*>>> = _experiments.asStateFlow()

  val userStats: StateFlow<UserStats> = analyticsRepository.userStats

  private val _trackingEnabled = MutableStateFlow(false)
  val trackingEnabled: StateFlow<Boolean> = _trackingEnabled.asStateFlow()

  private val _shouldNavigateToLogin = MutableStateFlow(false)
  val shouldNavigateToLogin: StateFlow<Boolean> = _shouldNavigateToLogin.asStateFlow()

  init {
    setupGuestModeCallback()
    loadExperiments()
    profile.loadUserData()
    loadAnalyticsData()
  }

  private fun setupGuestModeCallback() {
    userRepository.onGuestModeProfileModificationAttempt = { _shouldNavigateToLogin.value = true }
  }

  fun onNavigatedToLogin() {
    _shouldNavigateToLogin.value = false
  }

  private fun loadExperiments() {
    _experiments.value = experimentRepository.getExperiments()
  }

  private fun loadAnalyticsData() {
    _trackingEnabled.value = analyticsRepository.isTrackingEnabled
  }

  fun <T : Treatment> updateExperimentTreatment(experiment: Experiment<T>, treatment: Treatment) {
    experimentRepository.updateExperimentTreatment(experiment, treatment)
    loadExperiments() // Refresh the state
  }

  fun updateTrackingEnabled(enabled: Boolean) {
    analyticsRepository.isTrackingEnabled = enabled
    _trackingEnabled.value = enabled
  }

  fun resetStats() {
    analyticsRepository.resetStats()
  }
}

class SettingsViewModelFactory(private val context: Context) : ViewModelProvider.Factory {
  override fun <T : ViewModel> create(modelClass: Class<T>): T {
    if (modelClass.isAssignableFrom(SettingsViewModel::class.java)) {
      @Suppress("UNCHECKED_CAST")
      return SettingsViewModel(
        ExperimentRepository(context),
        UserRepository(context),
        AnalyticsRepository(context),
      )
        as T
    }
    throw IllegalArgumentException("Unknown ViewModel class")
  }
}
