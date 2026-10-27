package dev.jasonpearson.automobile.settings

import dev.jasonpearson.automobile.storage.UserProfile
import dev.jasonpearson.automobile.storage.UserRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

interface SettingsProfile {
  val email: StateFlow<String>
  val name: StateFlow<String>
  val isEditingEmail: StateFlow<Boolean>
  val tempEmail: StateFlow<String>

  fun startEmailEditing(currentEmail: String)

  fun updateTempEmail(email: String)

  fun dismissEmailEdit()

  fun saveEmail(email: String)

  fun updateName(name: String)
}

internal class SettingsProfileState(private val userRepository: UserRepository) : SettingsProfile {
  private val _email = MutableStateFlow("john.doe@example.com")
  override val email: StateFlow<String> = _email.asStateFlow()

  private val _name = MutableStateFlow("John Doe")
  override val name: StateFlow<String> = _name.asStateFlow()

  private val _isEditingEmail = MutableStateFlow(false)
  override val isEditingEmail: StateFlow<Boolean> = _isEditingEmail.asStateFlow()

  private val _tempEmail = MutableStateFlow("")
  override val tempEmail: StateFlow<String> = _tempEmail.asStateFlow()

  fun loadUserData() {
    val userProfile = userRepository.getUserProfile()
    if (userProfile == null) {
      // Create default user profile
      val defaultProfile = UserProfile("John Doe", "john.doe@example.com")
      userRepository.saveUserProfile(defaultProfile)
      _name.value = defaultProfile.name
      _email.value = defaultProfile.email
    } else {
      _name.value = userProfile.name
      _email.value = userProfile.email
    }
  }

  override fun startEmailEditing(currentEmail: String) {
    _tempEmail.value = currentEmail
    _isEditingEmail.value = true
  }

  override fun updateTempEmail(email: String) {
    _tempEmail.value = email
  }

  override fun dismissEmailEdit() {
    _isEditingEmail.value = false
  }

  override fun saveEmail(email: String) {
    userRepository.updateEmail(email)
    _email.value = email
    _isEditingEmail.value = false
  }

  override fun updateName(name: String) {
    userRepository.updateName(name)
    _name.value = name
  }
}
