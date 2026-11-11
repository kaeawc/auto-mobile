package dev.jasonpearson.automobile.glassesfixture

import android.app.Activity
import android.os.Bundle
import android.view.KeyEvent
import android.view.MotionEvent
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
  private lateinit var inputStatus: TextView
  private lateinit var clickStatus: TextView
  private var clickCount = 0
  private var lastClickedItem: String? = null
  private var lastLongClickedItem: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val root =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(24, 72, 24, 24)
      }
    val focusStatus = TextView(this).apply { id = R.id.focus_status }
    clickStatus =
      TextView(this).apply {
        id = R.id.click_status
        text = FixtureStatus.click(clickCount, lastClickedItem, lastLongClickedItem)
      }
    inputStatus =
      TextView(this).apply {
        id = R.id.input_status
        text = FixtureStatus.INPUT_NONE
      }
    root.addView(focusStatus)
    root.addView(clickStatus)
    root.addView(inputStatus)

    var firstButton: Button? = null
    for (number in 1..5) {
      val item = "Item $number"
      val button =
        Button(this).apply {
          text = item
          contentDescription = item
          isFocusable = true
          isFocusableInTouchMode = true
          isClickable = true
          setOnFocusChangeListener { _, hasFocus ->
            if (hasFocus) focusStatus.text = FixtureStatus.focus(item)
          }
          setOnClickListener {
            clickCount += 1
            lastClickedItem = item
            updateClickStatus()
          }
          setOnLongClickListener {
            lastLongClickedItem = item
            updateClickStatus()
            true
          }
        }
      root.addView(button)
      if (number == 1) firstButton = button
    }
    setContentView(root)
    firstButton?.requestFocus()
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    inputStatus.text =
      FixtureStatus.key(
        KeyEvent.keyCodeToString(event.keyCode),
        if (event.action == KeyEvent.ACTION_DOWN) "ACTION_DOWN" else "ACTION_UP",
      )
    return super.dispatchKeyEvent(event)
  }

  override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
    inputStatus.text = FixtureStatus.motion(event.source, MotionEvent.actionToString(event.action))
    return super.dispatchGenericMotionEvent(event)
  }

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    inputStatus.text = FixtureStatus.motion(event.source, MotionEvent.actionToString(event.action))
    return super.dispatchTouchEvent(event)
  }

  private fun updateClickStatus() {
    clickStatus.text = FixtureStatus.click(clickCount, lastClickedItem, lastLongClickedItem)
  }
}
