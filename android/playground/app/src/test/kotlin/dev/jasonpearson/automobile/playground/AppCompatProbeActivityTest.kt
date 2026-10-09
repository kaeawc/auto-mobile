package dev.jasonpearson.automobile.playground

import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class AppCompatProbeActivityTest {

  @Test
  fun probeIsAnAppCompatActivityThatCountsTaps() {
    val activity = Robolectric.buildActivity(AppCompatProbeActivity::class.java).setup().get()
    assertTrue(activity is AppCompatActivity)

    val count = activity.findViewById<TextView>(R.id.appcompat_count)
    assertEquals("Taps: 0", count.text.toString())

    activity.findViewById<Button>(R.id.appcompat_button).performClick()
    activity.findViewById<Button>(R.id.appcompat_button).performClick()
    assertEquals("Taps: 2", count.text.toString())
  }
}
