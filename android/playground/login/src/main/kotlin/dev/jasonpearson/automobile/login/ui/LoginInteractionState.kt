package dev.jasonpearson.automobile.login.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

internal class LoginInteractionState {
  var username by mutableStateOf("")
  var password by mutableStateOf("")
  var usernameHadContent by mutableStateOf(false)
  var passwordHadContent by mutableStateOf(false)
  var usernameBlurred by mutableStateOf(false)
  var passwordBlurred by mutableStateOf(false)

  fun recordUsernameContent() {
    if (username.length >= 5) usernameHadContent = true
  }

  fun recordPasswordContent() {
    if (password.length >= 5) passwordHadContent = true
  }

  fun usernameField(state: LoginFormState) =
    LoginFieldState(username, state.usernameError, usernameHadContent, usernameBlurred)

  fun passwordField(state: LoginFormState) =
    LoginFieldState(password, state.passwordError, passwordHadContent, passwordBlurred)
}
