package dev.jasonpearson.automobile.discover

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp

/** Repeated identifiers intentionally exercise descendant selection (#7156). */
@Composable
fun NestedSelectorsScreen() {
  Column(
    modifier = Modifier.padding(16.dp).semantics { testTagsAsResourceId = true },
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Text("Nested selectors")
    NestedSelectorCart("cart_A", listOf("item_42", "item_73"))
    NestedSelectorCart("cart_B", listOf("item_42"))
  }
}

@Composable
private fun NestedSelectorCart(cart: String, items: List<String>) {
  Column(Modifier.testTag(cart)) {
    Text(cart)
    Column {
      items.forEach { item -> key(item) { NestedSelectorRow(cart, item) } }
    }
  }
}

@Composable
private fun NestedSelectorRow(cart: String, item: String) {
  var quantity by remember { mutableStateOf("1") }
  var removed by remember { mutableStateOf(false) }
  Column(Modifier.testTag(item)) {
    Text("$cart/$item: quantity=$quantity, removed=$removed", Modifier.testTag("state"))
    Row {
      OutlinedTextField(
        value = quantity,
        onValueChange = { quantity = it },
        label = { Text("Quantity") },
        modifier = Modifier.weight(1f).testTag("quantity"),
      )
      if (!removed) {
        Button(onClick = { removed = true }, modifier = Modifier.testTag("remove")) {
          Text("Remove")
        }
      }
    }
  }
}
