package dev.jasonpearson.automobile.demos

import android.content.res.Configuration
import android.graphics.Color
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.viewinterop.AndroidView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import dev.jasonpearson.automobile.design.system.components.AutoMobileTopAppBar
import dev.jasonpearson.automobile.sdk.TrackRecomposition

/**
 * An XML RecyclerView whose rows all carry the same resource id (`shared_row_id_row`) and differ
 * only by visible text, so a page swipe replaces every visible row with rows of the same id.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SharedRowIdListScreen(onNavigateBack: () -> Unit) {
  TrackRecomposition(
    id = "screen.demo.lists.shared_row_id",
    composableName = "SharedRowIdListScreen",
  ) {
    Scaffold(
      topBar = {
        AutoMobileTopAppBar(
          title = { Text(text = "Shared Row Id List") },
          navigationIcon = {
            IconButton(
              onClick = onNavigateBack,
              modifier = Modifier.semantics { testTag = "shared_row_id_back" },
            ) {
              Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
              )
            }
          },
        )
      },
    ) { paddingValues ->
      AndroidView(
        modifier = Modifier.fillMaxSize().padding(paddingValues),
        factory = { context ->
          LayoutInflater.from(context)
            .inflate(R.layout.screen_shared_row_id_list, null, false)
            .apply { bindSharedRowIdList() }
        },
      )
    }
  }
}

private fun View.bindSharedRowIdList() {
  val textColor =
    if (
      resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
        Configuration.UI_MODE_NIGHT_YES
    ) {
      Color.WHITE
    } else {
      Color.BLACK
    }
  val selection = findViewById<TextView>(R.id.shared_row_id_selection)
  selection.setTextColor(textColor)
  findViewById<RecyclerView>(R.id.shared_row_id_list).apply {
    layoutManager = LinearLayoutManager(context)
    adapter =
      SharedRowIdAdapter(sharedRowIdLabels(), textColor) { label ->
        selection.text = resources.getString(R.string.shared_row_id_selected, label)
      }
  }
}

private class SharedRowIdAdapter(
  private val labels: List<String>,
  private val textColor: Int,
  private val onRowClick: (String) -> Unit,
) : RecyclerView.Adapter<SharedRowIdAdapter.RowHolder>() {

  class RowHolder(val row: TextView) : RecyclerView.ViewHolder(row)

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RowHolder {
    val row =
      LayoutInflater.from(parent.context).inflate(R.layout.item_shared_row_id, parent, false)
        as TextView
    row.setTextColor(textColor)
    return RowHolder(row)
  }

  override fun onBindViewHolder(holder: RowHolder, position: Int) {
    val label = labels[position]
    holder.row.text = label
    holder.row.setOnClickListener { onRowClick(label) }
  }

  override fun getItemCount(): Int = labels.size
}
