package dev.jasonpearson.automobile.login.ui

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import dev.jasonpearson.automobile.design.system.theme.AutoMobileDimensions
import dev.jasonpearson.automobile.design.system.theme.AutoMobileTheme
import dev.jasonpearson.automobile.login.R

internal data class LoginFieldState(
  val value: String,
  val error: Int?,
  val hadContent: Boolean,
  val blurred: Boolean,
) {
  val showError: Boolean
    get() {
      val shortened = hadContent && value.length < 5
      val invalidAfterBlur = blurred && error != null
      return shortened || invalidAfterBlur
    }
}

internal data class LoginFormActions(
  val onUsernameChange: (String) -> Unit,
  val onPasswordChange: (String) -> Unit,
  val onPasswordDone: () -> Unit,
)

/** Form section containing username and password input fields. */
@Composable
internal fun LoginForm(
  username: LoginFieldState,
  password: LoginFieldState,
  actions: LoginFormActions,
  modifier: Modifier = Modifier,
) {
  Column(modifier = modifier) {
    UsernameField(username, actions.onUsernameChange)
    Spacer(modifier = Modifier.height(AutoMobileDimensions.spacing4))
    PasswordField(password, actions.onPasswordChange, actions.onPasswordDone)
  }
}

@Composable
private fun UsernameField(field: LoginFieldState, onUsernameChange: (String) -> Unit) {
  OutlinedTextField(
    value = field.value,
    onValueChange = onUsernameChange,
    label = { Text(stringResource(R.string.prompt_email)) },
    keyboardOptions =
      KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
    isError = field.showError,
    supportingText = {
      if (field.showError) {
        field.error?.let {
          Text(text = stringResource(it), color = MaterialTheme.colorScheme.error)
        }
      }
    },
    modifier = Modifier.fillMaxWidth(),
  )
}

@Composable
private fun PasswordField(
  field: LoginFieldState,
  onPasswordChange: (String) -> Unit,
  onPasswordDone: () -> Unit,
) {
  OutlinedTextField(
    value = field.value,
    onValueChange = onPasswordChange,
    label = { Text(stringResource(R.string.prompt_password)) },
    visualTransformation = PasswordVisualTransformation(),
    keyboardOptions =
      KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
    keyboardActions = KeyboardActions(onDone = { onPasswordDone() }),
    isError = field.showError,
    supportingText = {
      if (field.showError) {
        field.error?.let {
          Text(text = stringResource(it), color = MaterialTheme.colorScheme.error)
        }
      }
    },
    modifier = Modifier.fillMaxWidth(),
  )
}

@Preview(name = "Login Form", showBackground = true, uiMode = Configuration.UI_MODE_NIGHT_NO)
@Preview(
  name = "Login Form - Dark",
  showBackground = true,
  uiMode = Configuration.UI_MODE_NIGHT_YES,
)
@Composable
fun LoginFormPreview() {
  AutoMobileTheme {
    Column(Modifier.background(MaterialTheme.colorScheme.background)) {
      LoginForm(
        username = LoginFieldState("user@example.com", null, hadContent = true, blurred = false),
        password = LoginFieldState("password123", null, hadContent = true, blurred = false),
        actions =
          LoginFormActions(onUsernameChange = {}, onPasswordChange = {}, onPasswordDone = {}),
      )
    }
  }
}
