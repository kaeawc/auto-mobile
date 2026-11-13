package dev.jasonpearson.automobile.protocol

/**
 * Node and image budgets per stack screen (#14213), mirroring the host's `PrototypeScreenBudget`.
 * Renderers draw only a stack's top screen, so each screen is charged its own subtree plus
 * everything drawn with it: the content outside the stack and, for a screen holding a nested stack,
 * that stack's largest screen. Sibling screens never count against each other. Every node and image
 * also counts against the whole-spec ceiling. A spec without a stack has one scope.
 */
class PrototypeScreenBudget(
  private val maxNodes: Int = PrototypeSpecValidator.MAX_PROTOTYPE_NODES,
  private val maxImages: Int = PrototypeSpecValidator.MAX_PROTOTYPE_IMAGES,
  private val maxSpecNodes: Int = PrototypeSpecValidator.MAX_PROTOTYPE_SPEC_NODES,
  private val maxSpecImages: Int = PrototypeSpecValidator.MAX_PROTOTYPE_SPEC_IMAGES,
) {
  enum class Overflow(val message: String) {
    NODES("Node limit exceeded"),
    IMAGES("Image limit exceeded"),
    SPEC_NODES("Spec node limit exceeded"),
    SPEC_IMAGES("Spec image limit exceeded");

    val expandedMessage: String
      get() = "Expanded ${message.replaceFirstChar { it.lowercaseChar() }}"
  }

  private data class Counts(var nodes: Int = 0, var images: Int = 0)

  private class Scope(val base: Counts, val own: Counts = Counts(), val children: Counts = Counts())

  private val scopes = ArrayDeque(listOf(Scope(Counts())))
  private val stacks = ArrayDeque<Counts>()
  private val total = Counts()

  fun enterStack() {
    stacks.addLast(Counts())
  }

  fun enterScreen() {
    val parent = scopes.last()
    scopes.addLast(
      Scope(
        Counts(
          parent.base.nodes + parent.own.nodes + parent.children.nodes,
          parent.base.images + parent.own.images + parent.children.images,
        ),
      ),
    )
  }

  fun exitScreen() {
    val screen = scopes.removeLast()
    val stack = stacks.last()
    stack.nodes = maxOf(stack.nodes, screen.own.nodes + screen.children.nodes)
    stack.images = maxOf(stack.images, screen.own.images + screen.children.images)
  }

  fun exitStack() {
    val stack = stacks.removeLast()
    val parent = scopes.last()
    parent.children.nodes += stack.nodes
    parent.children.images += stack.images
  }

  /** Charges nodes and images to the open screen; returns the first bound crossed. */
  fun charge(nodes: Int, images: Int): Overflow? {
    val scope = scopes.last()
    scope.own.nodes += nodes
    scope.own.images += images
    total.nodes += nodes
    total.images += images
    return when {
      scope.base.nodes + scope.own.nodes + scope.children.nodes > maxNodes -> Overflow.NODES
      total.nodes > maxSpecNodes -> Overflow.SPEC_NODES
      scope.base.images + scope.own.images + scope.children.images > maxImages -> Overflow.IMAGES
      total.images > maxSpecImages -> Overflow.SPEC_IMAGES
      else -> null
    }
  }
}
