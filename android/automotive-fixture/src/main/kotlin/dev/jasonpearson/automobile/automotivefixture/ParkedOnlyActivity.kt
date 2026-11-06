package dev.jasonpearson.automobile.automotivefixture

import android.app.Activity
import android.os.Bundle

/**
 * Deliberately not distraction-optimized: while the vehicle is moving the car UX restrictions
 * replace it with the system blocking screen.
 */
class ParkedOnlyActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_parked_only)
  }
}
