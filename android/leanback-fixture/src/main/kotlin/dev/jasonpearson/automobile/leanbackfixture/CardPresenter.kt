package dev.jasonpearson.automobile.leanbackfixture

import android.view.ViewGroup
import androidx.core.content.ContextCompat
import androidx.leanback.widget.ImageCardView
import androidx.leanback.widget.Presenter

/** Renders a [FixtureCard] as an [ImageCardView] with a fixed local image and size. */
class CardPresenter : Presenter() {
  override fun onCreateViewHolder(parent: ViewGroup): ViewHolder {
    val card =
      ImageCardView(parent.context).apply {
        isFocusable = true
        isFocusableInTouchMode = true
        val density = resources.displayMetrics.density
        setMainImageDimensions(
          (CARD_WIDTH_DP * density).toInt(),
          (CARD_HEIGHT_DP * density).toInt(),
        )
      }
    return ViewHolder(card)
  }

  override fun onBindViewHolder(viewHolder: ViewHolder, item: Any?) {
    val card = item as? FixtureCard ?: return
    val view = viewHolder.view as ImageCardView
    view.titleText = card.title
    view.contentText = card.id
    view.mainImage = ContextCompat.getDrawable(view.context, R.drawable.card_image)
  }

  override fun onUnbindViewHolder(viewHolder: ViewHolder) {
    (viewHolder.view as ImageCardView).mainImage = null
  }

  private companion object {
    // Matches the Compose fixture's card size: about four and a half cards fit a 1080p row.
    const val CARD_WIDTH_DP = 196
    const val CARD_HEIGHT_DP = 110
  }
}
