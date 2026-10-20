package dev.jasonpearson.automobile.desktop.core.layout

/** Order-preserving free-gap alignment; ties prefer a diagonal before the caller's gap policy. */
internal fun alignSequenceSlots(
  n: Int,
  m: Int,
  similarity: (Int, Int) -> Double,
  preferSkipA: (Int, Int, Double, Double) -> Boolean = { i, j, skipA, skipB ->
    i > 0 && (j == 0 || skipA >= skipB)
  },
): Pair<IntArray, IntArray> {
  val score = alignmentScores(n, m, similarity)
  val columnsA = ArrayList<Int>()
  val columnsB = ArrayList<Int>()
  var i = n
  var j = m
  while (i > 0 || j > 0) {
    val diagonal = alignmentDiagonal(score, i, j, similarity)
    val skipA = if (i > 0) score[i - 1][j] else Double.NEGATIVE_INFINITY
    val skipB = if (j > 0) score[i][j - 1] else Double.NEGATIVE_INFINITY
    val canPair = i > 0 && j > 0
    when {
      canPair && diagonal >= skipA && diagonal >= skipB -> {
        columnsA.add(--i)
        columnsB.add(--j)
      }
      preferSkipA(i, j, skipA, skipB) -> {
        columnsA.add(--i)
        columnsB.add(-1)
      }
      else -> {
        columnsA.add(-1)
        columnsB.add(--j)
      }
    }
  }
  return numberAlignmentSlots(n, m, columnsA, columnsB)
}

private fun numberAlignmentSlots(
  n: Int,
  m: Int,
  columnsA: List<Int>,
  columnsB: List<Int>,
): Pair<IntArray, IntArray> {
  val slotsA = IntArray(n)
  val slotsB = IntArray(m)
  var slot = 0
  for (column in columnsA.indices.reversed()) {
    val aIndex = columnsA[column]
    val bIndex = columnsB[column]
    if (aIndex >= 0) slotsA[aIndex] = slot
    if (bIndex >= 0) slotsB[bIndex] = slot
    slot++
  }
  return slotsA to slotsB
}

private fun alignmentScores(n: Int, m: Int, similarity: (Int, Int) -> Double): Array<DoubleArray> {
  val score = Array(n + 1) { DoubleArray(m + 1) }
  for (i in 1..n) for (j in 1..m) {
    score[i][j] =
      maxOf(score[i - 1][j - 1] + similarity(i - 1, j - 1), score[i - 1][j], score[i][j - 1])
  }

  return score
}

private fun alignmentDiagonal(
  score: Array<DoubleArray>,
  i: Int,
  j: Int,
  similarity: (Int, Int) -> Double,
): Double =
  if (i > 0 && j > 0) score[i - 1][j - 1] + similarity(i - 1, j - 1) else Double.NEGATIVE_INFINITY
