package dev.jasonpearson.automobile.demos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileTextField
import dev.jasonpearson.automobile.design.system.components.AutoMobileTopAppBar

private val CartNames = listOf("cart_A", "cart_B")
private val ItemIds = (40..47).map { "item_$it" }

/**
 * Two carts holding rows with the same ids (item_40..item_47), each with a `quantity` field and a
 * `remove` button, so nested container selection can be verified against duplicate leaf ids. The
 * status line records which cart/item last received an action.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NestedSelectionDemoScreen(onNavigateBack: () -> Unit) {
  val rows = remember {
    CartNames.associateWith { mutableStateListOf<String>().apply { addAll(ItemIds) } }
  }
  val quantities = remember { mutableStateMapOf<String, String>() }
  var status by remember { mutableStateOf("status: idle") }

  Scaffold(
    topBar = {
      AutoMobileTopAppBar(
        title = { Text(text = "Nested Selection") },
        navigationIcon = {
          IconButton(onClick = onNavigateBack) {
            Icon(imageVector = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
          }
        },
      )
    },
  ) { paddingValues ->
    NestedSelectionContent(paddingValues, rows, quantities, status) { status = it }
  }
}

@Composable
private fun SelectionCart(
  cart: String,
  items: List<String>,
  quantity: (String) -> String,
  onQuantityChange: (String, String) -> Unit,
  onRemove: (String) -> Unit,
) {
  Text(text = cart)
  Column(
    modifier =
      Modifier.fillMaxWidth().height(210.dp).verticalScroll(rememberScrollState()).semantics {
        testTag = cart
      },
  ) {
    items.forEach { item ->
      Row(
        modifier = Modifier.fillMaxWidth().semantics { testTag = item },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        AutoMobileTextField(
          value = quantity(item),
          onValueChange = { onQuantityChange(item, it) },
          label = { Text("$item qty") },
          modifier = Modifier.height(64.dp).weight(1f).semantics { testTag = "quantity" },
        )
        AutoMobileContentButton(
          onClick = {
            onRemove(item)
          },
          modifier = Modifier.semantics { testTag = "remove" },
        ) {
          Text("Remove")
        }
      }
    }
  }
}

@Composable
private fun SelectionCartActions(onReverse: () -> Unit, onDrop: () -> Unit) {
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    AutoMobileContentButton(
      onClick = onReverse,
      modifier = Modifier.semantics { testTag = "reverse_cart_A" },
    ) {
      Text("Reverse A")
    }
    AutoMobileContentButton(
      onClick = onDrop,
      modifier = Modifier.semantics { testTag = "drop_cart_A_item_42" },
    ) {
      Text("Drop A/42")
    }
  }
}

@Composable
private fun NestedSelectionContent(
  paddingValues: androidx.compose.foundation.layout.PaddingValues,
  rows: Map<String, androidx.compose.runtime.snapshots.SnapshotStateList<String>>,
  quantities: MutableMap<String, String>,
  status: String,
  onStatus: (String) -> Unit,
) {
  Column(
    modifier =
      Modifier.fillMaxSize().padding(paddingValues).padding(horizontal = 12.dp).semantics {
        testTagsAsResourceId = true
      },
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(
      text = status,
      modifier = Modifier.semantics { testTag = "selection_status" },
    )
    SelectionCartActions(
      onReverse = {
        rows.getValue("cart_A").reverse()
        onStatus("status: reversed cart_A")
      },
      onDrop = {
        rows.getValue("cart_A").remove("item_42")
        onStatus("status: dropped cart_A/item_42")
      },
    )

    CartNames.forEach { cart ->
      SelectionCart(
        cart = cart,
        items = rows.getValue(cart).toList(),
        quantity = { item -> quantities["$cart/$item"] ?: "" },
        onQuantityChange = { item, value -> quantities["$cart/$item"] = value },
        onRemove = { item ->
          rows.getValue(cart).remove(item)
          onStatus("status: removed $cart/$item")
        },
      )
    }
  }
}
