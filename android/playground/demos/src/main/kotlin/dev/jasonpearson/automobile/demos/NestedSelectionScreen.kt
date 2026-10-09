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
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
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
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
          onClick = {
            rows.getValue("cart_A").reverse()
            status = "status: reversed cart_A"
          },
          modifier = Modifier.semantics { testTag = "reverse_cart_A" },
        ) {
          Text("Reverse A")
        }
        Button(
          onClick = {
            rows.getValue("cart_A").remove("item_42")
            status = "status: dropped cart_A/item_42"
          },
          modifier = Modifier.semantics { testTag = "drop_cart_A_item_42" },
        ) {
          Text("Drop A/42")
        }
      }
      CartNames.forEach { cart ->
        Text(text = cart)
        Column(
          modifier =
            Modifier.fillMaxWidth().height(210.dp).verticalScroll(rememberScrollState()).semantics {
              testTag = cart
            },
        ) {
          rows.getValue(cart).toList().forEach { item ->
            Row(
              modifier = Modifier.fillMaxWidth().semantics { testTag = item },
              horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
              OutlinedTextField(
                value = quantities["$cart/$item"] ?: "",
                onValueChange = { quantities["$cart/$item"] = it },
                label = { Text("$item qty") },
                modifier = Modifier.height(64.dp).weight(1f).semantics { testTag = "quantity" },
              )
              Button(
                onClick = {
                  rows.getValue(cart).remove(item)
                  status = "status: removed $cart/$item"
                },
                modifier = Modifier.semantics { testTag = "remove" },
              ) {
                Text("Remove")
              }
            }
          }
        }
      }
    }
  }
}
