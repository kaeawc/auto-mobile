package dev.jasonpearson.automobile.protoviewer

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource

@Composable
internal fun ProtoViewerTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme(),
  ) {
    Surface(content = content)
  }
}

@Composable
internal fun ResetConfirmation(cancel: () -> Unit, reset: () -> Unit) {
  AlertDialog(
    onDismissRequest = cancel,
    title = { Text(stringResource(R.string.reset_title)) },
    text = { Text(stringResource(R.string.reset_body)) },
    confirmButton = {
      TextButton(onClick = reset, modifier = Modifier.testTag("confirm-reset")) {
        Text(stringResource(R.string.reset))
      }
    },
    dismissButton = { TextButton(onClick = cancel) { Text(stringResource(R.string.cancel)) } },
  )
}
