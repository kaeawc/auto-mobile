package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp

/** The `testTag` / resource id every host dismiss control shares with iOS (#15119). */
internal const val PROTOTYPE_DISMISS_TEST_TAG = "automobile-prototype-dismiss"

/** The accessible name of every host dismiss control. */
internal const val PROTOTYPE_DISMISS_LABEL = "Dismiss AutoMobile prototype"

/** The chip's drawn diameter; its hit target is [minimumInteractiveComponentSize] (48 dp). */
internal val PROTOTYPE_CLOSE_CHIP_DIAMETER = 32.dp

/**
 * The circular close chip the persistent Close control and the dismiss bar share, the Android twin
 * of iOS's `automobile-prototype-dismiss` chip: an opaque [prototypeCloseColors] fill with a Close
 * glyph, no text label, so a text match for "Close" cannot land on it.
 */
@Composable
internal fun PrototypeCloseChip(onClick: () -> Unit, modifier: Modifier = Modifier) {
  val colors = prototypeCloseColors(MaterialTheme.colorScheme)
  // An ancestor carries the flag: observe reads the tag as the resource id from it.
  Box(modifier.semantics { testTagsAsResourceId = true }) {
    Box(
      Modifier.minimumInteractiveComponentSize()
        .clickable(role = Role.Button, onClick = onClick)
        .semantics { contentDescription = PROTOTYPE_DISMISS_LABEL }
        .testTag(PROTOTYPE_DISMISS_TEST_TAG),
      contentAlignment = Alignment.Center,
    ) {
      Box(
        Modifier.size(PROTOTYPE_CLOSE_CHIP_DIAMETER).background(colors.background, CircleShape),
        contentAlignment = Alignment.Center,
      ) {
        Icon(Icons.Filled.Close, contentDescription = null, tint = colors.content, modifier = Modifier.size(18.dp))
      }
    }
  }
}
