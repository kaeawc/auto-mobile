import Foundation

/// Same wire shape as CtrlProxy's PrototypeStackSnapshot; depth is always derived from the path.
struct PrototypeStackSnapshot: Equatable {
    let path: [String]
    var depth: Int { path.count }
    var wireObject: [String: Any] { ["path": path, "depth": depth] }
}

enum PrototypeStacks {
    /// Raw stack-screen children for JSONValue validators that must inspect every authored screen.
    static func screenChildren(in fields: [String: JSONValue], path: String) -> [(JSONValue, String)] {
        guard case let .object(screens)? = fields["screens"] else { return [] }
        return screens.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }).compactMap { name in
            screens[name].map { ($0, screenPath(path, name: name)) }
        }
    }

    /// Shared fixture path spelling, including screen names containing quotes or punctuation.
    static func screenPath(_ path: String, name: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        let encoded = (try? encoder.encode(name)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
        return "\(path).screens[\(encoded)]"
    }

    /// The new stack forms are checked at show, like the agent's theme-mode forms. All screens
    /// participate, including inactive screens and actions in composite buttons.
    static func validate(root: PrototypeNode) throws {
        var nodes: [(node: PrototypeNode, path: String)] = []
        func collect(_ node: PrototypeNode, path: String) {
            nodes.append((node, path))
            for entry in node.childEntries(path: path) {
                collect(entry.node, path: entry.path)
            }
        }
        collect(root, path: "root")
        var stacks: [String: PrototypeNode] = [:]
        for (node, path) in nodes where node.type == "stack" {
            guard let id = node.id else { throw PrototypeThemeModes.violation("\(path).id", "Expected string") }
            if stacks[id] != nil { throw PrototypeThemeModes.violation("\(path).id", "Duplicate stack id") }
            if node.child != nil || node.children != nil {
                throw PrototypeThemeModes.violation(path, "Stack uses screens instead of child or children")
            }
            guard let screens = node.screens, (1 ... PrototypeLimits.maxStackScreens).contains(screens.count) else {
                throw PrototypeThemeModes.violation("\(path).screens", "Screen count out of range")
            }
            if screens[""] != nil {
                throw PrototypeThemeModes.violation(screenPath(path, name: ""), "Empty screen name")
            }
            guard let start = node.start, screens[start] != nil else {
                throw PrototypeThemeModes.violation("\(path).start", "Unknown start screen")
            }
            stacks[id] = node
        }
        for (node, path) in nodes {
            var groups: [(actions: [PrototypeAction], path: String)] = [(node.onTap ?? [], "\(path).onTap")]
            groups += [(node.navigationIcon?.onTap ?? [], "\(path).navigationIcon.onTap")]
            for (index, button) in (node.actions ?? []).enumerated() {
                groups.append((button.onTap ?? [], "\(path).actions[\(index)].onTap"))
            }
            groups += [
                (node.confirm?.onTap ?? [], "\(path).confirm.onTap"),
                (node.dismiss?.onTap ?? [], "\(path).dismiss.onTap"),
                (node.action?.onTap ?? [], "\(path).action.onTap"),
            ]
            for group in groups {
                for (index, action) in group.actions.enumerated() {
                    try validate(action, path: "\(group.path)[\(index)]", stacks: stacks)
                }
            }
        }
    }

    private static func validate(_ action: PrototypeAction, path: String, stacks: [String: PrototypeNode]) throws {
        guard ["push", "pop", "popToRoot", "replace"].contains(action.type) else { return }
        guard let id = action.stack, let node = stacks[id] else {
            throw PrototypeThemeModes.violation("\(path).stack", "Unknown stack id")
        }
        if action.type == "push" || action.type == "replace" {
            guard let screen = action.screen, node.screens?[screen] != nil else {
                throw PrototypeThemeModes.violation("\(path).screen", "Unknown stack screen")
            }
        }
    }

    /// Pure Android Back policy: visit parents before children (nested wins), and siblings in
    /// document order (last eligible wins). Visible modal bodies take priority over inline stacks,
    /// including bottomSheet, which iOS draws inline. Hidden screens never compete for Back.
    static func popTarget(
        root: PrototypeNode, state: [String: JSONValue], pages: [String: Int],
        stacks: [String: PrototypeStackSnapshot]
    )
        -> String?
    {
        let modalTypes = prototypeModalTypes.union(["bottomSheet"])
        var target: String?
        var modals: [PrototypeNode] = []
        func shown(_ node: PrototypeNode) -> Bool {
            (node.visibleWhen?.holds(state) ?? true) &&
                (!modalTypes.contains(node.type) || (node.openWhen?.holds(state) ?? false))
        }
        func collectModals(_ node: PrototypeNode) {
            guard shown(node) else { return }
            if modalTypes.contains(node.type) { modals.append(node) }
            for entry in node.currentChildEntries(path: "root", pages: pages, stacks: stacks, state: state) {
                collectModals(entry.node)
            }
        }
        func visit(_ node: PrototypeNode) {
            guard shown(node), !modalTypes.contains(node.type) else { return }
            if node.type == "stack", let id = node.id, (stacks[id]?.depth ?? 1) > 1 { target = id }
            for entry in node
                .currentChildEntries(path: "root", pages: pages, stacks: stacks, state: state) { visit(entry.node) }
        }
        visit(root)
        collectModals(root)
        for modal in modals {
            for entry in modal
                .currentChildEntries(path: "root", pages: pages, stacks: stacks, state: state) { visit(entry.node) }
        }
        return target
    }
}

extension PrototypeNode {
    func collectStacks(into nodes: inout [String: PrototypeNode]) {
        if type == "stack", let id { nodes[id] = self }
        for entry in childEntries(path: "root") { entry.node.collectStacks(into: &nodes) }
    }

    func currentScreen(stacks: [String: PrototypeStackSnapshot]) -> String? {
        id.flatMap { stacks[$0]?.path.last } ?? start
    }

    /// Children that can be rendered or exposed to accessibility. A stack contributes only its top
    /// screen; a pager contributes only its current page; a search bar contributes its child only
    /// while active (absent state is inactive). Structural walkers use childEntries.
    /// Appearance and modal discovery require an exact page; anchors clamp past the end like rendering.
    func currentChildEntries(
        path: String, pages: [String: Int], stacks: [String: PrototypeStackSnapshot],
        state: [String: JSONValue]? = nil, clampPagerPage: Bool = true
    )
        -> [(node: PrototypeNode, path: String)]
    {
        if type == "stack" {
            guard let screen = currentScreen(stacks: stacks), let node = screens?[screen] else { return [] }
            return [(node, PrototypeStacks.screenPath(path, name: screen))]
        }
        if type == "searchBar", !searchBarActive(state: state ?? [:]) { return [] }
        let entries = childEntries(path: path)
        if type == "pager" {
            let requestedPage = id.flatMap { pages[$0] } ?? 0
            let page = clampPagerPage ? Swift.min(requestedPage, Swift.max(entries.count - 1, 0)) : requestedPage
            return entries.indices.contains(page) ? [entries[page]] : []
        }
        return entries
    }
}
