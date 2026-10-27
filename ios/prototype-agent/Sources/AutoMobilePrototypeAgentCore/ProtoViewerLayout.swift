import Foundation

/// ProtoViewer's own chrome keys on the platform's native horizontal size class: compact on a phone,
/// the iPhone Duo cover panel and a narrow iPad window; regular on a full iPad window and the Duo inner
/// panel. There are no Material window-size breakpoints on iOS (#15244). Prototype content is separate:
/// it sizes from its own window, never from this.
enum ProtoViewerWidthClass: Sendable, Equatable {
    case compact
    case regular

    /// `isRegular` is nil when SwiftUI reports no size class (outside a window); that stays the phone layout.
    init(isRegular: Bool?) {
        self = isRegular == true ? .regular : .compact
    }

    /// Settings, licenses and error text stop growing at a readable measure on wide windows.
    var readableContentWidth: Double? {
        switch self {
        case .compact: nil
        case .regular: 640
        }
    }

    /// Library sidebar column width at regular width, in points.
    static let sidebarWidth = (min: 280.0, ideal: 340.0, max: 420.0)
}

/// What the library detail pane shows. An MCP open is distinct from a plain open of the same entry: its id
/// carries the request, so a second open remounts the screen and reports its own result.
enum PrototypeLibraryDestination: Hashable, Identifiable, Sendable {
    case entry(PrototypeLibraryEntry)
    case mcp(entry: PrototypeLibraryEntry, command: PrototypeMcpRequest)

    var id: String {
        switch self {
        case let .entry(entry): "entry:\(entry.libraryId)"
        case let .mcp(entry, command): "mcp:\(entry.libraryId):\(command.request)"
        }
    }

    var entry: PrototypeLibraryEntry {
        switch self {
        case let .entry(entry), let .mcp(entry, _): entry
        }
    }

    // By id only: a refresh bumps the entry's lastOpenedAt, and the list row's tag must still equal the selection.
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// Library selection shared by the compact stack and the regular split view. NavigationSplitView collapses to
/// a stack at compact width and keeps this selection, so the open prototype survives a size-class change
/// (iPad window resize, Duo fold or unfold) without a reload. The list writes `selection` through a binding.
struct PrototypeLibraryNavigation: Equatable, Sendable {
    var selection: PrototypeLibraryDestination?

    mutating func openMcp(_ entry: PrototypeLibraryEntry, command: PrototypeMcpRequest) {
        selection = .mcp(entry: entry, command: command)
    }

    mutating func close() {
        selection = nil
    }

    /// A deleted entry must not stay open in the detail pane (a stack never showed it while deleting).
    mutating func didDelete(libraryId: String) {
        if selection?.entry.libraryId == libraryId { selection = nil }
    }
}
