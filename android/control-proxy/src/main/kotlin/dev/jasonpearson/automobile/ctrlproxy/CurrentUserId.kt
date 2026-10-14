package dev.jasonpearson.automobile.ctrlproxy

/**
 * Android encodes the numeric user ID in the UID using UserHandle.PER_USER_RANGE (100,000).
 * Dividing Process.myUid() by that range matches hidden UserHandle.myUserId() without reflection.
 * There is no public numeric user-ID getter; Process.myUid() is public since API 1.
 */
internal object CurrentUserId {
  const val PER_USER_RANGE = 100_000

  fun forUid(uid: Int): Int = uid / PER_USER_RANGE

  fun current(): Int = forUid(android.os.Process.myUid())
}
