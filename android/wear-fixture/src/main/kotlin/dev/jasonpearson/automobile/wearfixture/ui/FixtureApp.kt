package dev.jasonpearson.automobile.wearfixture.ui

import android.Manifest
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.MaterialTheme
import dev.jasonpearson.automobile.wearfixture.FixtureRoute
import dev.jasonpearson.automobile.wearfixture.FixtureState
import dev.jasonpearson.automobile.wearfixture.LaunchEvent
import dev.jasonpearson.automobile.wearfixture.WearFixtureCatalog
import dev.jasonpearson.automobile.wearfixture.notification.FixtureNotifications

private val FixtureStateSaver =
  Saver<FixtureState, List<Any>>(save = { it.toSaved() }, restore = FixtureState::fromSaved)

/** Root composable: holds [FixtureState] and routes UI events into its transitions. */
@Composable
fun FixtureApp(launch: LaunchEvent, notifications: FixtureNotifications) {
  var state by rememberSaveable(stateSaver = FixtureStateSaver) { mutableStateOf(FixtureState()) }
  val update: (FixtureState.() -> FixtureState) -> Unit = { state = state.it() }
  val notificationRunner = rememberNotificationRunner(notifications) { update { withStatus(it) } }

  LaunchedEffect(launch.sequence) {
    // Sequence 0 is a recreated activity: keep the saved state instead of replaying the intent.
    if (launch.sequence != 0) update { launched(launch.request) }
  }
  BackHandler(enabled = state.backStack.canPop) { update { back() } }

  val onAction: (String) -> Unit = { actionId ->
    val next = state.onHomeAction(actionId)
    if (next != null) state = next else notificationRunner(actionId)
  }

  MaterialTheme {
    AppScaffold(modifier = Modifier.semantics { testTagsAsResourceId = true }) {
      key(state.backStack.current.route) { RouteContent(state, update, onAction) }
      ConfirmDialog(visible = state.showConfirm, onResult = { update { confirmResult(it) } })
    }
  }
}

@Composable
private fun RouteContent(
  state: FixtureState,
  update: (FixtureState.() -> FixtureState) -> Unit,
  onAction: (String) -> Unit,
) {
  when (val route = state.backStack.current) {
    FixtureRoute.Home ->
      HomeScreen(status = state.status, onAction = onAction, onItem = { update { openItem(it) } })
    is FixtureRoute.Detail ->
      DetailScreen(itemId = route.itemId, onDismissed = { update { back() } })
    FixtureRoute.Picker ->
      PickerScreen(
        index = state.pickerIndex,
        onIndexChange = { update { pickerChanged(it) } },
        onDismissed = { update { back() } },
      )
    FixtureRoute.Dismiss -> DismissScreen(onDismissed = { update { dismissScreenDismissed() } })
  }
}

/**
 * Runs a notification home action, asking for POST_NOTIFICATIONS first when it is missing, and
 * reports the resulting status line.
 */
@Composable
private fun rememberNotificationRunner(
  notifications: FixtureNotifications,
  onStatus: (String) -> Unit,
): (String) -> Unit {
  var pendingAction by remember { mutableStateOf<String?>(null) }
  val launcher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      val action = pendingAction
      pendingAction = null
      if (granted && action != null) {
        onStatus(runNotificationAction(action, notifications))
      } else {
        onStatus(WearFixtureCatalog.STATUS_PERMISSION_DENIED)
      }
    }
  return { actionId ->
    // canPost() is always true below API 33, so the request only happens where the permission
    // exists.
    val needsPermission =
      actionId != WearFixtureCatalog.ACTION_ONGOING_STOP && !notifications.canPost()
    if (needsPermission) {
      pendingAction = actionId
      launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
    } else {
      onStatus(runNotificationAction(actionId, notifications))
    }
  }
}

private fun runNotificationAction(actionId: String, notifications: FixtureNotifications): String =
  when (actionId) {
    WearFixtureCatalog.ACTION_NOTIFY ->
      if (notifications.postAlert()) WearFixtureCatalog.STATUS_ALERT_POSTED
      else WearFixtureCatalog.STATUS_PERMISSION_DENIED
    WearFixtureCatalog.ACTION_ONGOING_START ->
      if (notifications.startOngoing()) WearFixtureCatalog.STATUS_ONGOING_STARTED
      else WearFixtureCatalog.STATUS_PERMISSION_DENIED
    WearFixtureCatalog.ACTION_ONGOING_STOP -> {
      notifications.stopOngoing()
      WearFixtureCatalog.STATUS_ONGOING_STOPPED
    }
    else -> error("Unknown fixture action $actionId")
  }
