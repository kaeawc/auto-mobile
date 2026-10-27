package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.WindowAdaptiveInfo
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.layout.*
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.window.core.layout.WindowSizeClass
import dev.jasonpearson.automobile.protocol.PrototypeAdaptiveNode

/** Uses Android's native window classes, including fold posture in the pane directive. */
@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
internal fun RenderPrototypeAdaptive(
  node: PrototypeRenderNode,
  modifier: Modifier = Modifier,
  interact: (PrototypeInteraction) -> Unit,
  windowInfo: WindowAdaptiveInfo = currentWindowAdaptiveInfo(),
) {
  val source = node.source as PrototypeAdaptiveNode
  when (source.kind) {
    "listDetail" -> AdaptiveListDetail(node, modifier, interact, windowInfo)
    "navigationSuite" -> AdaptiveNavigation(node, modifier, interact, windowInfo)
    "supporting" -> AdaptiveSupporting(node, modifier, interact, windowInfo)
  }
}

internal fun adaptiveNavigationType(width: WindowSizeClass): NavigationSuiteType =
  when {
    width.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_EXPANDED_LOWER_BOUND) ->
      NavigationSuiteType.NavigationDrawer
    width.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND) ->
      NavigationSuiteType.NavigationRail
    else -> NavigationSuiteType.NavigationBar
  }

private fun adaptiveChild(node: PrototypeRenderNode, slot: String): PrototypeRenderNode? =
  node.children.firstOrNull { it.identity == "${node.identity}.$slot" }

@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
private fun AdaptiveListDetail(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
  info: WindowAdaptiveInfo,
) {
  val source = node.source as PrototypeAdaptiveNode
  val directive = calculatePaneScaffoldDirective(info)
  val compact = directive.maxHorizontalPartitions == 1
  val selected = !node.selectedValue.isNullOrEmpty()
  val back = {
    interact(PrototypeInteraction.Choose(checkNotNull(source.selectionKey), "", emptyList()))
  }
  val value =
    calculateThreePaneScaffoldValue(
      directive.maxHorizontalPartitions,
      ListDetailPaneScaffoldDefaults.adaptStrategies(),
      ThreePaneScaffoldDestinationItem<Nothing>(
        if (selected) ListDetailPaneScaffoldRole.Detail else ListDetailPaneScaffoldRole.List,
      ),
    )
  ListDetailPaneScaffold(
    directive = directive,
    value = value,
    modifier = modifier,
    listPane = { adaptiveChild(node, "list")?.let { RenderPrototypeNode(it, interact) } },
    detailPane = {
      Column(Modifier.fillMaxSize()) {
        if (compact && selected)
          TextButton(
            onClick = back,
            modifier = Modifier.testTag("${node.testTag ?: node.identity}.back"),
          ) {
            Text("Back")
          }
        adaptiveChild(node, "detail")?.let { RenderPrototypeNode(it, interact) }
      }
    },
  )
}

@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
private fun AdaptiveNavigation(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
  info: WindowAdaptiveInfo,
) {
  val source = node.source as PrototypeAdaptiveNode
  NavigationSuiteScaffold(
    modifier = modifier,
    layoutType = adaptiveNavigationType(info.windowSizeClass),
    navigationSuiteItems = {
      source.items.orEmpty().forEachIndexed { index, option ->
        item(
          selected = option.value == node.selectedValue,
          onClick = {
            interact(
              PrototypeInteraction.Choose(checkNotNull(source.stateKey), option.value, emptyList()),
            )
          },
          icon = { Text(option.label.take(1)) },
          label = { Text(option.label) },
          modifier = Modifier.testTag("${node.testTag ?: node.identity}.item-$index"),
        )
      }
    },
  ) {
    adaptiveChild(node, "content")?.let { RenderPrototypeNode(it, interact) }
  }
}

@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
private fun AdaptiveSupporting(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
  info: WindowAdaptiveInfo,
) {
  val source = node.source as PrototypeAdaptiveNode
  val directive = calculatePaneScaffoldDirective(info)
  val compact = directive.maxHorizontalPartitions == 1
  val close = { interact(PrototypeInteraction.Toggle(checkNotNull(source.openKey), emptyList())) }
  val value =
    calculateThreePaneScaffoldValue(
      if (node.checked) directive.maxHorizontalPartitions else 1,
      SupportingPaneScaffoldDefaults.adaptStrategies(),
      ThreePaneScaffoldDestinationItem<Nothing>(
        if (compact && node.checked) SupportingPaneScaffoldRole.Supporting
        else SupportingPaneScaffoldRole.Main,
      ),
    )
  SupportingPaneScaffold(
    directive = directive,
    value = value,
    modifier = modifier,
    mainPane = { adaptiveChild(node, "main")?.let { RenderPrototypeNode(it, interact) } },
    supportingPane = {
      Column(Modifier.fillMaxSize()) {
        TextButton(
          onClick = close,
          modifier = Modifier.testTag("${node.testTag ?: node.identity}.close"),
        ) {
          Text("Close")
        }
        adaptiveChild(node, "supporting")?.let { RenderPrototypeNode(it, interact) }
      }
    },
  )
}
