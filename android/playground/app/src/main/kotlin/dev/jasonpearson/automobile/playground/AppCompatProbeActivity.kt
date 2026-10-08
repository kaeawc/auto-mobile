package dev.jasonpearson.automobile.playground

import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Minimal [AppCompatActivity] screen. AppCompat installs its own window callback, so this screen
 * lets device checks confirm AutoMobile's click tracker still sees exactly one tap per touch on an
 * AppCompat host. Launch with `am start -n dev.jasonpearson.automobile.playground/.AppCompatProbeActivity`.
 */
class AppCompatProbeActivity : AppCompatActivity() {
  private var taps = 0

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_appcompat_probe)
    val count = findViewById<TextView>(R.id.appcompat_count)
    findViewById<Button>(R.id.appcompat_button).setOnClickListener {
      taps += 1
      count.text = getString(R.string.appcompat_probe_count, taps)
    }
  }
}
