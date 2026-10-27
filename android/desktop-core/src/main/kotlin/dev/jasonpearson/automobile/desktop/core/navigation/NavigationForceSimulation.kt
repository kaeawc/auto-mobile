@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import kotlin.math.abs

private data class SimNode(
  val id: String,
  var x: Float,
  var y: Float,
  var vx: Float = 0f,
  var vy: Float = 0f,
)

private data class SimLink(val source: SimNode, val target: SimNode)

private fun pointToSegmentDistance(
  point: androidx.compose.ui.geometry.Offset,
  start: androidx.compose.ui.geometry.Offset,
  end: androidx.compose.ui.geometry.Offset,
): Triple<Float, Float, Float> {
  val px = point.x
  val py = point.y
  val x1 = start.x
  val y1 = start.y
  val x2 = end.x
  val y2 = end.y
  // Returns (distance, closestX, closestY)
  val dx = x2 - x1
  val dy = y2 - y1
  val lengthSq = dx * dx + dy * dy

  if (lengthSq == 0f) {
    // Segment is a point
    val dist = kotlin.math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1))
    return Triple(dist, x1, y1)
  }

  // Project point onto segment, clamped to [0, 1]
  val t = maxOf(0f, minOf(1f, ((px - x1) * dx + (py - y1) * dy) / lengthSq))

  // Find closest point on segment
  val closestX = x1 + t * dx
  val closestY = y1 + t * dy
  val dist = kotlin.math.sqrt((px - closestX) * (px - closestX) + (py - closestY) * (py - closestY))

  return Triple(dist, closestX, closestY)
}

internal class NavigationForceSimulation(
  screens: List<ScreenNode>,
  transitions: List<ScreenTransition>,
  private val nodeWidth: Float,
  private val nodeHeight: Float,
) {
  // Create mutable node state for simulation

  // Initialize nodes in a phyllotaxis pattern (like D3 does for better initial spread)
  private val nodes = screens.mapIndexed { i, screen ->
    val angle = Math.PI * (3 - kotlin.math.sqrt(5.0)) * i // Golden angle
    val radius = 10f * kotlin.math.sqrt(i.toFloat() + 0.5f)
    SimNode(
      id = screen.name,
      x = (radius * kotlin.math.cos(angle)).toFloat(),
      y = (radius * kotlin.math.sin(angle)).toFloat(),
    )
  }
  private val nodeById = nodes.associateBy { it.id }

  // Build link list (forward transitions only)

  private val links =
    transitions
      .filter { it.trigger != "back" }
      .mapNotNull { t ->
        val source = nodeById[t.fromScreen]
        val target = nodeById[t.toScreen]
        if (source != null && target != null && source != target) {
          SimLink(source, target)
        } else null
      }
      .distinctBy { setOf(it.source.id, it.target.id) } // Deduplicate bidirectional

  // Count connections per node (for link strength calculation)
  private val connectionCount = mutableMapOf<String, Int>().withDefault { 0 }

  init {
    links.forEach { link ->
      connectionCount[link.source.id] = connectionCount.getValue(link.source.id) + 1
      connectionCount[link.target.id] = connectionCount.getValue(link.target.id) + 1
    }
  }

  // Force parameters (tuned for navigation graph with larger nodes)
  private val linkDistance = nodeWidth * 2.5f // Target distance between linked nodes
  private val linkStrength = 0.3f // Link spring strength
  private val chargeStrength = -400f // Repulsion strength (negative = repel)
  private val centerStrength = 0.05f // Pull toward center
  private val collisionStrength = 1.0f // Collision force strength (strongest!)
  private val collisionPadding = 20f // Extra padding between nodes
  private val edgeRepulsionStrength = 0.8f // How strongly nodes avoid edges
  private val edgeRepulsionDistance = nodeHeight // Distance at which edge repulsion kicks in
  private val velocityDecay = 0.6f // Friction (1 = no decay, 0 = instant stop)

  // Collision bounds (rectangle with padding)
  private val collisionWidth = nodeWidth + collisionPadding
  private val collisionHeight = nodeHeight + collisionPadding

  // Helper to compute closest point on line segment and distance

  // Simulation parameters
  private var alpha = 1f // Current "temperature"
  private val alphaMin = 0.001f // Stop when alpha drops below this
  private val alphaDecay = 0.0228f // How fast alpha decreases (1 - 0.001^(1/300))

  // Center point for forceX/forceY
  private val centerX = 0f
  private val centerY = 0f

  fun simulate(): List<NodePosition> {
    var iterations = 0
    val maxIterations = 300
    while (alpha > alphaMin && iterations < maxIterations) {
      iterations++
      decayVelocities()
      applyCollisions()
      repelEdges()
      applyLinks()
      repelNodes()
      centerNodes()
      moveNodes()
      alpha *= (1 - alphaDecay)
    }
    repeat(10) { resolveFinalCollisions() }
    // Compute bounding box and add padding
    val minX = nodes.minOfOrNull { it.x } ?: 0f
    val minY = nodes.minOfOrNull { it.y } ?: 0f
    val paddingX = 100f + nodeWidth / 2
    val paddingY = 100f + nodeHeight / 2

    return nodes.map { node ->
      NodePosition(
        screenId = node.id,
        x = node.x - minX + paddingX,
        y = node.y - minY + paddingY,
      )
    }
  }

  private fun decayVelocities() {
    // Reset velocities contribution for this tick
    nodes.forEach { node ->
      node.vx *= velocityDecay
      node.vy *= velocityDecay
    }
  }

  private fun applyCollisions() {
    // 1. COLLISION FORCE (strongest - applied first and directly moves nodes)
    // Check all pairs and push apart if overlapping
    for (i in nodes.indices) {
      for (j in i + 1 until nodes.size) {
        val nodeA = nodes[i]
        val nodeB = nodes[j]

        separateNodes(nodeA, nodeB)
      }
    }
  }

  private fun repelEdges() {
    // 2. EDGE-NODE REPULSION: Push nodes away from edges they don't belong to
    links.forEach { link ->
      nodes.forEach { node ->
        // Skip if this node is part of this edge
        if (node.id == link.source.id || node.id == link.target.id) return@forEach

        // Calculate distance from node center to edge line segment
        val (distance, closestX, closestY) =
          pointToSegmentDistance(
            androidx.compose.ui.geometry.Offset(node.x, node.y),
            androidx.compose.ui.geometry.Offset(link.source.x, link.source.y),
            androidx.compose.ui.geometry.Offset(link.target.x, link.target.y),
          )

        // If node is too close to edge, push it away
        if (distance < edgeRepulsionDistance && distance > 0.1f) {
          // Direction away from closest point on edge
          val awayX = node.x - closestX
          val awayY = node.y - closestY
          val awayDist = kotlin.math.sqrt(awayX * awayX + awayY * awayY)

          if (awayDist > 0.1f) {
            // Stronger force when closer (inverse relationship)
            val strength = edgeRepulsionStrength * (1f - distance / edgeRepulsionDistance)
            val push = strength * (edgeRepulsionDistance - distance)

            node.vx += (awayX / awayDist) * push
            node.vy += (awayY / awayDist) * push
          }
        }
      }
    }
  }

  private fun applyLinks() {
    // 3. Link force: pull connected nodes toward target distance
    links.forEach { link ->
      val dx = link.target.x - link.source.x
      val dy = link.target.y - link.source.y
      var distance = kotlin.math.sqrt(dx * dx + dy * dy)
      if (distance == 0f) distance = 1f

      // D3-style adaptive strength: 1 / min(count(source), count(target))
      val adaptiveStrength =
        linkStrength /
          minOf(
            connectionCount.getValue(link.source.id),
            connectionCount.getValue(link.target.id),
          )

      // Spring force toward target distance
      val force = (distance - linkDistance) * adaptiveStrength * alpha
      val fx = (dx / distance) * force
      val fy = (dy / distance) * force

      // Apply to both nodes (Newton's third law)
      link.source.vx += fx
      link.source.vy += fy
      link.target.vx -= fx
      link.target.vy -= fy
    }
  }

  private fun repelNodes() {
    // 4. Many-body force: repulsion between all node pairs
    for (i in nodes.indices) {
      for (j in i + 1 until nodes.size) {
        val nodeA = nodes[i]
        val nodeB = nodes[j]

        var dx = nodeB.x - nodeA.x
        var dy = nodeB.y - nodeA.y
        var distSq = dx * dx + dy * dy

        // Minimum distance to avoid division by zero and extreme forces
        if (distSq < 1f) distSq = 1f
        val distance = kotlin.math.sqrt(distSq)

        // Inverse square law for repulsion
        val force = chargeStrength * alpha / distSq
        val fx = (dx / distance) * force
        val fy = (dy / distance) * force

        nodeA.vx += fx
        nodeA.vy += fy
        nodeB.vx -= fx
        nodeB.vy -= fy
      }
    }
  }

  private fun centerNodes() {
    // 5. ForceX: pull toward center X
    nodes.forEach { node ->
      node.vx += (centerX - node.x) * centerStrength * alpha
    }

    // 6. ForceY: pull toward center Y
    nodes.forEach { node ->
      node.vy += (centerY - node.y) * centerStrength * alpha
    }
  }

  private fun moveNodes() {
    // Apply velocities to positions
    nodes.forEach { node ->
      node.x += node.vx
      node.y += node.vy
    }
  }

  private fun resolveFinalCollisions() {

    for (i in nodes.indices) {
      for (j in i + 1 until nodes.size) {
        val nodeA = nodes[i]
        val nodeB = nodes[j]

        separateNodes(nodeA, nodeB)
      }
    }
  }

  private fun separateNodes(nodeA: SimNode, nodeB: SimNode) {
    // Calculate overlap using axis-aligned bounding boxes
    val dx = nodeB.x - nodeA.x
    val dy = nodeB.y - nodeA.y

    // Required separation (center to center)
    val minSepX = collisionWidth
    val minSepY = collisionHeight

    // Actual overlap amounts
    val overlapX = minSepX - kotlin.math.abs(dx)
    val overlapY = minSepY - kotlin.math.abs(dy)

    // If both overlaps are positive, nodes are colliding
    if (overlapX > 0 && overlapY > 0) {
      // Push apart along the axis of least overlap (feels more natural)
      if (overlapX < overlapY) {
        // Separate horizontally
        val push = overlapX * collisionStrength * 0.5f
        if (dx > 0) {
          nodeA.x -= push
          nodeB.x += push
        } else {
          nodeA.x += push
          nodeB.x -= push
        }
      } else {
        // Separate vertically
        val push = overlapY * collisionStrength * 0.5f
        if (dy > 0) {
          nodeA.y -= push
          nodeB.y += push
        } else {
          nodeA.y += push
          nodeB.y -= push
        }
      }
    }
  }
}
