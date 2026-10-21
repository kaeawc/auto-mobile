package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SearchBarDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeSearchBarNode

/** Results stay in this window and in a plain Column, including every authored result row. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RenderPrototypeSearchBar(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
  children: @Composable ColumnScope.() -> Unit,
) {
  val source = node.source as? PrototypeSearchBarNode ?: return
  val expanded = node.sheetOpen
  val docked = source.variant == "docked"
  Surface(
    modifier = if (expanded && !docked) modifier.fillMaxSize() else modifier,
    tonalElevation = if (expanded && docked) SearchBarDefaults.TonalElevation else 0.dp,
    shadowElevation = if (expanded && docked) SearchBarDefaults.ShadowElevation else 0.dp,
  ) {
    Column {
      RenderPrototypeEditableField(
        node,
        source.stateKey,
        source.onTap.orEmpty(),
        Modifier.fillMaxWidth().semantics {
          this[PrototypeRole] = node.role
          node.testTag?.let { testTag = it }
          node.contentDescription?.let { contentDescription = it }
        },
        interact,
      ) { shown, change, fieldModifier, presses ->
        // This overload supplies ImeAction.Search and KeyboardActions(onSearch) internally.
        SearchBarDefaults.InputField(
          query = shown,
          onQueryChange = change,
          onSearch = {
            val actions = source.onSubmit.orEmpty()
            if (actions.isNotEmpty()) interact(PrototypeInteraction.Tap(actions))
          },
          expanded = expanded,
          onExpandedChange = {}, // Focus never writes activeKey; only authored actions do.
          modifier = fieldModifier,
          placeholder = { Text(source.placeholder.orEmpty()) },
          leadingIcon = {
            prototypeIcon(source.leadingIcon)?.let { Icon(it, contentDescription = null) }
          },
          trailingIcon = {
            Row {
              source.trailingActions.orEmpty().forEachIndexed { index, action ->
                IconButton(
                  onClick = {
                    val actions = action.onTap.orEmpty()
                    if (actions.isNotEmpty()) interact(PrototypeInteraction.Tap(actions))
                  },
                  modifier =
                    Modifier.semantics {
                      contentDescription = action.label
                      node.testTag?.let { testTag = "$it.actions.$index" }
                    },
                ) {
                  prototypeIcon(action.icon)?.let { Icon(it, contentDescription = null) }
                }
              }
            }
          },
          interactionSource = presses,
        )
      }
      if (expanded) children()
    }
  }
}
