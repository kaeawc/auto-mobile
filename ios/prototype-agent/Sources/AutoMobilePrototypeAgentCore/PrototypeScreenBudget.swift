/// Node and image budgets per stack screen (#14213), mirroring the host's `PrototypeScreenBudget`.
/// Renderers draw only a stack's top screen, so each screen is charged its own subtree plus
/// everything drawn with it: the content outside the stack and, for a screen holding a nested
/// stack, that stack's largest screen. Sibling screens never count against each other. Every node
/// and image also counts against the whole-spec ceiling. A spec without a stack has one scope.
struct PrototypeScreenBudget {
    enum Overflow: Equatable {
        case nodes
        case images
        case specNodes
        case specImages

        var message: String {
            switch self {
            case .nodes: "Node limit exceeded"
            case .images: "Image limit exceeded"
            case .specNodes: "Spec node limit exceeded"
            case .specImages: "Spec image limit exceeded"
            }
        }

        var expandedMessage: String {
            switch self {
            case .nodes: "Expanded node limit exceeded"
            case .images: "Expanded image limit exceeded"
            case .specNodes: "Expanded spec node limit exceeded"
            case .specImages: "Expanded spec image limit exceeded"
            }
        }
    }

    private struct Counts {
        var nodes = 0
        var images = 0

        static func + (lhs: Counts, rhs: Counts) -> Counts {
            Counts(nodes: lhs.nodes + rhs.nodes, images: lhs.images + rhs.images)
        }
    }

    private struct Scope {
        var base = Counts()
        var own = Counts()
        var children = Counts()

        var drawn: Counts { base + own + children }
    }

    private let maxNodes: Int
    private let maxImages: Int
    private let maxSpecNodes: Int
    private let maxSpecImages: Int
    private var scopes = [Scope()]
    private var stacks: [Counts] = []
    private var total = Counts()

    init(
        maxNodes: Int = PrototypeLimits.maxNodes,
        maxImages: Int = PrototypeContractValidator.limit("MAX_PROTOTYPE_IMAGES"),
        maxSpecNodes: Int = PrototypeLimits.maxSpecNodes,
        maxSpecImages: Int = PrototypeContractValidator.limit("MAX_PROTOTYPE_SPEC_IMAGES")
    ) {
        self.maxNodes = maxNodes
        self.maxImages = maxImages
        self.maxSpecNodes = maxSpecNodes
        self.maxSpecImages = maxSpecImages
    }

    mutating func enterStack() {
        stacks.append(Counts())
    }

    mutating func enterScreen() {
        scopes.append(Scope(base: scopes[scopes.count - 1].drawn))
    }

    mutating func exitScreen() {
        let screen = scopes.removeLast()
        let extent = screen.own + screen.children
        let last = stacks.count - 1
        stacks[last].nodes = max(stacks[last].nodes, extent.nodes)
        stacks[last].images = max(stacks[last].images, extent.images)
    }

    mutating func exitStack() {
        let stack = stacks.removeLast()
        let last = scopes.count - 1
        scopes[last].children = scopes[last].children + stack
    }

    /// Charges nodes and images to the open screen; returns the first bound crossed.
    mutating func charge(nodes: Int, images: Int) -> Overflow? {
        let last = scopes.count - 1
        scopes[last].own.nodes += nodes
        scopes[last].own.images += images
        total.nodes += nodes
        total.images += images
        let drawn = scopes[last].drawn
        if drawn.nodes > maxNodes { return .nodes }
        if total.nodes > maxSpecNodes { return .specNodes }
        if drawn.images > maxImages { return .images }
        return total.images > maxSpecImages ? .specImages : nil
    }
}
