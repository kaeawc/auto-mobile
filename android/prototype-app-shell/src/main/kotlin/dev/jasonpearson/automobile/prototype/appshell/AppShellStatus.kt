package dev.jasonpearson.automobile.prototype.appshell

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

@Composable
internal fun AppShellStatus(state: AppShellState, close: () -> Unit) {
  val title =
    when (state) {
      AppShellState.MissingSpec -> R.string.prototype_missing_spec
      AppShellState.CorruptSpec -> R.string.prototype_corrupt_spec
      else -> null
    }
  val tag =
    when (state) {
      AppShellState.MissingSpec -> "missing-spec"
      AppShellState.CorruptSpec -> "corrupt-spec"
      else -> "loading"
    }
  BackHandler(onBack = close)
  Surface(Modifier.fillMaxSize().testTag("prototype-app-state-$tag")) {
    if (title != null) {
      Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
      ) {
        Text(stringResource(title), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.prototype_error_body))
        Button(onClick = close) { Text(stringResource(R.string.prototype_close)) }
      }
    }
  }
}
