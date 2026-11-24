package dev.jasonpearson.automobile.playground

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import androidx.appcompat.app.AppCompatActivity

/**
 * Minimal share source: one button that opens the system share sheet for a text payload. Launch
 * with `am start -n dev.jasonpearson.automobile.playground/.ShareSourceActivity`.
 */
class ShareSourceActivity : AppCompatActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(
      Button(this).apply {
        text = getString(R.string.share_source_button)
        contentDescription = getString(R.string.share_source_button)
        setOnClickListener {
          val send =
            Intent(Intent.ACTION_SEND).apply {
              type = "text/plain"
              putExtra(Intent.EXTRA_TEXT, getString(R.string.share_source_payload))
            }
          startActivity(Intent.createChooser(send, null))
        }
      },
    )
  }
}
