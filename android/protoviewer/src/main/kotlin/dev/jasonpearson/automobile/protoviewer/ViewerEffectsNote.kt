package dev.jasonpearson.automobile.protoviewer

import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntime
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeEffectReport
import java.util.Locale

/** A sibling overlay inside the clipped viewer surface, below the app-owned controls. */
@Composable
internal fun BoxScope.ViewerEffectsNote(runtime: PrototypeRuntime) {
  val snapshot by runtime.snapshots.collectAsState()
  val budget by runtime.effectHealth.reports.collectAsState()
  val effects =
    remember(runtime, snapshot, budget) {
      prototypeEffectReport(runtime.renderModel(snapshot).root, runtime.effectHealth)
    }
  val template = stringResource(R.string.effects_degraded)
  val note =
    viewerEffectsNote(effects) { api, frozen ->
      template.format(Locale.getDefault(), api, frozen)
    }
  if (note != null) {
    Surface(
      modifier = Modifier.align(Alignment.BottomStart).padding(8.dp).testTag("viewer-effects-note"),
      color = MaterialTheme.colorScheme.secondaryContainer,
      shape = MaterialTheme.shapes.small,
    ) {
      Text(
        note,
        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        style = MaterialTheme.typography.labelSmall,
      )
    }
  }
}
