package dev.jasonpearson.automobile.login.ui

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.jasonpearson.automobile.design.system.components.AutoMobileOutlinedCard
import dev.jasonpearson.automobile.design.system.components.AutoMobileText
import dev.jasonpearson.automobile.design.system.theme.AutoMobileDimensions
import dev.jasonpearson.automobile.design.system.theme.AutoMobileTheme
import dev.jasonpearson.automobile.login.R
import dev.jasonpearson.automobile.login.data.LoginRepository
import dev.jasonpearson.automobile.sdk.TrackRecomposition
import dev.jasonpearson.automobile.storage.UserPreferences
import kotlinx.coroutines.delay

/**
 * Core login screen composable that handles user authentication with a provided ViewModel.
 *
 * @param viewModel The LoginViewModel that manages authentication state
 * @param onLoginSuccess Callback invoked when login is successful
 * @param onLoginError Callback invoked when login fails
 * @param onGuestMode Callback invoked when guest mode is selected
 */
@Composable
fun LoginScreenCore(
  viewModel: LoginViewModel,
  onLoginSuccess: (LoggedInUserView) -> Unit,
  onLoginError: (Int) -> Unit,
  onGuestMode: () -> Unit = {},
) {
  val loginFormState by viewModel.loginFormState.collectAsStateWithLifecycle()
  val loginResult by viewModel.loginResult.collectAsStateWithLifecycle()

  val form = remember { LoginInteractionState() }
  var isLoading by remember { mutableStateOf(false) }

  LaunchedEffect(form.username) { form.recordUsernameContent() }
  LaunchedEffect(form.password) { form.recordPasswordContent() }

  // Handle login result
  LaunchedEffect(loginResult) {
    loginResult?.let { result ->
      isLoading = false
      result.error?.let { onLoginError(it) }
      result.success?.let { onLoginSuccess(it) }
    }
  }

  // Handle form validation
  LaunchedEffect(form.username, form.password) {
    viewModel.loginDataChanged(form.username, form.password)
  }

  // Check if form is valid for button animation
  val isFormValid =
    loginFormState.isDataValid && form.username.isNotEmpty() && form.password.isNotEmpty()

  LoginContent(
    form = form,
    loginFormState = loginFormState,
    isFormValid = isFormValid,
    isLoading = isLoading,
    actions =
      LoginContentActions(
        onPasswordDone = {
          form.passwordBlurred = true
          if (isFormValid) {
            isLoading = true
            viewModel.login(form.username, form.password)
          }
        },
        onSignInClick = {
          form.usernameBlurred = true
          form.passwordBlurred = true
          isLoading = true
          viewModel.login(form.username, form.password)
        },
        onGuestMode = onGuestMode,
      ),
  )
}

private data class LoginContentActions(
  val onPasswordDone: () -> Unit,
  val onSignInClick: () -> Unit,
  val onGuestMode: () -> Unit,
)

@Composable
private fun LoginContent(
  form: LoginInteractionState,
  loginFormState: LoginFormState,
  isFormValid: Boolean,
  isLoading: Boolean,
  actions: LoginContentActions,
) {
  val configuration = LocalConfiguration.current
  val isLandscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

  // Use smaller spacing and make scrollable in landscape
  val scrollState = rememberScrollState()

  Column(
    modifier =
      Modifier.fillMaxSize()
        .background(MaterialTheme.colorScheme.background)
        .then(if (isLandscape) Modifier.verticalScroll(scrollState) else Modifier)
        .padding(16.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Spacer(modifier = Modifier.height(AutoMobileDimensions.spacing12))

    LoginHeader()

    Spacer(modifier = Modifier.height(AutoMobileDimensions.spacing12))

    LoginForm(
      username = form.usernameField(loginFormState),
      password = form.passwordField(loginFormState),
      actions =
        LoginFormActions(
          onUsernameChange = {
            form.username = it
            if (it.length >= 5) form.usernameHadContent = true
          },
          onPasswordChange = {
            form.password = it
            if (it.length >= 5) form.passwordHadContent = true
          },
          onPasswordDone = actions.onPasswordDone,
        ),
    )

    Spacer(modifier = Modifier.height(AutoMobileDimensions.spacing6))

    LoginActions(
      isFormValid = isFormValid,
      isLoading = isLoading,
      onSignInClick = actions.onSignInClick,
      onGuestModeClick = actions.onGuestMode,
    )

    Spacer(modifier = Modifier.weight(1f))
  }
}

/**
 * Login screen composable with dependency injection for use in playground app. This version handles
 * creating the ViewModel and managing user preferences.
 *
 * @param userPreferences The user preferences to mark authenticated on successful login
 * @param onNavigateToHome Callback invoked when login is successful to navigate to home
 * @param onGuestMode Callback invoked when guest mode is selected
 */
@Composable
fun LoginScreen(
  userPreferences: UserPreferences,
  onNavigateToHome: () -> Unit,
  onGuestMode: () -> Unit = {},
) {
  TrackRecomposition(id = "screen.login", composableName = "LoginScreen") {
    val context = LocalContext.current
    val viewModelFactory = remember { LoginViewModelFactory(LoginRepository(context)) }

    val loginViewModel: LoginViewModel = viewModel(factory = viewModelFactory)

    // Add error state management
    var loginError by remember { mutableStateOf<String?>(null) }
    var showErrorMessage by remember { mutableStateOf(false) }

    LoginScreenCore(
      viewModel = loginViewModel,
      onLoginSuccess = { user ->
        // Clear any previous errors
        loginError = null
        showErrorMessage = false

        userPreferences.isAuthenticated = true
        onNavigateToHome()
      },
      onLoginError = { errorString ->
        // Handle login error - show error message instead of crashing
        loginError =
          when (errorString) {
            R.string.login_failed -> "Invalid email or password"
            R.string.invalid_username -> "Please enter a valid email address"
            R.string.invalid_password -> "Password must be at least 6 characters"
            else -> "Login failed. Please try again."
          }
        showErrorMessage = true
      },
      onGuestMode = onGuestMode,
    )

    // Show error message if login fails
    val errorMessage = loginError
    if (showErrorMessage && errorMessage != null) {
      LaunchedEffect(loginError) {
        // Auto-hide error after 3 seconds
        delay(3000)
        showErrorMessage = false
      }

      Box(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        contentAlignment = Alignment.BottomCenter,
      ) {
        AutoMobileOutlinedCard { AutoMobileText(text = errorMessage) }
      }
    }
  }

  /** Preview for the LoginScreen composable with mock data. */
  @Preview(name = "Login", showBackground = true, uiMode = Configuration.UI_MODE_NIGHT_NO)
  @Preview(name = "Login - Dark", showBackground = true, uiMode = Configuration.UI_MODE_NIGHT_YES)
  @Composable
  fun LoginScreenPreviewComposable() {

    val context = LocalContext.current
    val mockRepository = LoginRepository(context)
    val mockViewModel = remember { LoginViewModel(mockRepository) }

    val isDarkMode =
      when (LocalConfiguration.current.uiMode and Configuration.UI_MODE_NIGHT_MASK) {
        Configuration.UI_MODE_NIGHT_YES -> true
        else -> false
      }

    AutoMobileTheme(darkTheme = isDarkMode) {
      Column(modifier = Modifier.background(MaterialTheme.colorScheme.background)) {
        LoginScreenCore(
          viewModel = mockViewModel,
          onLoginSuccess = { /* Preview login success */ },
          onLoginError = { /* Preview login error */ },
          onGuestMode = { /* Preview guest mode */ },
        )
      }
    }
  }
}
