package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeScrollRefresh
import dev.jasonpearson.automobile.protocol.PrototypeSetStateAction

/**
 * What a pull runs: the refresh key is set to true first, so the indicator shows, then the authored
 * `onRefresh` actions run in order. The prototype or a patch writes false to end the indicator.
 */
internal fun prototypeRefreshActions(refresh: PrototypeScrollRefresh): List<PrototypeAction> =
  listOf<PrototypeAction>(
    PrototypeSetStateAction(refresh.stateKey, PrototypeScalar.BooleanValue(true)),
  ) + refresh.onRefresh

/**
 * Material pull-to-refresh around a vertical scroll. [refreshing] is the bound boolean; a pull
 * while it is already true does nothing, so a slow `onRefresh` is not re-run.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PrototypeRefreshBox(
  refresh: PrototypeScrollRefresh,
  refreshing: Boolean,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
  content: @Composable BoxScope.() -> Unit,
) {
  PullToRefreshBox(
    isRefreshing = refreshing,
    onRefresh = {
      if (!refreshing) interact(PrototypeInteraction.Tap(prototypeRefreshActions(refresh)))
    },
    modifier = modifier,
    content = content,
  )
}
