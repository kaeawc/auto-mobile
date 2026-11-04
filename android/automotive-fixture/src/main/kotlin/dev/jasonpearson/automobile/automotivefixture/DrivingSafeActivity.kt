package dev.jasonpearson.automobile.automotivefixture

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.TextView

/**
 * Launcher activity declared distraction-optimized, so it stays usable while driving. Its long list
 * gives checks something to scroll; its first row opens [ParkedOnlyActivity].
 */
class DrivingSafeActivity : Activity() {
  private var selected: FixtureRow? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_driving_safe)
    val status = findViewById<TextView>(R.id.fixture_status)
    selected = savedInstanceState?.getString(KEY_SELECTED)?.let(::rowById)
    status.text = FixtureCatalog.selectionStatus(selected)

    val rows = findViewById<ListView>(R.id.fixture_rows)
    rows.adapter =
      ArrayAdapter(
        this,
        R.layout.fixture_row,
        R.id.fixture_row_title,
        FixtureCatalog.homeRows.map { it.title },
      )
    rows.setOnItemClickListener { _, _, position, _ ->
      val row = FixtureCatalog.homeRows[position]
      when (FixtureCatalog.destinationFor(row)) {
        HomeDestination.PARKED_ONLY -> startActivity(Intent(this, ParkedOnlyActivity::class.java))
        HomeDestination.SELECT -> {
          selected = row
          status.text = FixtureCatalog.selectionStatus(row)
        }
      }
    }
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    selected?.let { outState.putString(KEY_SELECTED, it.id) }
  }

  private fun rowById(id: String): FixtureRow? = FixtureCatalog.homeRows.firstOrNull { it.id == id }

  private companion object {
    const val KEY_SELECTED = "selected_row"
  }
}
