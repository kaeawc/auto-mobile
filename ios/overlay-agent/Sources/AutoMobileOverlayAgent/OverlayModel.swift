import Combine
import SwiftUI
import UIKit

/// Overlay state owned by the main thread: the shown spec, authored state, pager selection and assets.
final class OverlayModel: ObservableObject {
    @Published private(set) var spec: OverlaySpec?
    @Published var state: [String: JSONValue] = [:]
    @Published var pages: [String: Int] = [:]
    @Published var safeInsets = UIEdgeInsets.zero
    private(set) var pageCounts: [String: Int] = [:]
    var assets: [String: UIImage] = [:]

    /// Window-space rects that accept touches; everything else passes through to the app.
    var hitRects: [String: CGRect] = [:]

    /// Per overlay id, monotonic from 1 (the Android emitter contract).
    private var sequences: [String: Int] = [:]
    var onEvent: (([String: Any]) -> Void)?
    var onVisibilityChange: ((Bool) -> Void)?

    func show(_ spec: OverlaySpec) {
        var counts: [String: Int] = [:]
        spec.root.collectPagers(into: &counts)
        pageCounts = counts
        pages = counts.mapValues { _ in 0 }
        state = spec.state ?? [:]
        // Keep the touchable rects: SwiftUI re-reports a frame only when it changes, so clearing
        // them on a same-geometry re-show would leave the overlay passing every touch through.
        if self.spec?.id != spec.id {
            sequences[spec.id] = 0
        }
        self.spec = spec
        onVisibilityChange?(true)
    }

    func replace(_ spec: OverlaySpec) {
        var counts: [String: Int] = [:]
        spec.root.collectPagers(into: &counts)
        pageCounts = counts
        pages = counts.mapValues { _ in 0 }.merging(pages.filter { counts[$0.key] != nil }) { _, kept in kept }
        if let authored = spec.state {
            state.merge(authored) { _, new in new }
        }
        self.spec = spec
    }

    func mergeState(_ values: [String: JSONValue]) {
        state.merge(values) { _, new in new }
    }

    func dismiss(reportEvent: Bool) {
        guard spec != nil else { return }
        if reportEvent {
            emit(kind: "dismissed", name: nil, payload: .null)
        }
        spec = nil
        hitRects = [:]
        onVisibilityChange?(false)
    }

    func missingAssets() -> [String] {
        guard let spec else { return [] }
        var ids = Set<String>()
        spec.root.collectAssets(into: &ids)
        return ids.filter { assets[$0] == nil }.sorted()
    }

    // MARK: Actions

    func run(_ actions: [OverlayAction]) {
        for action in actions {
            switch action.type {
            case "emit":
                emit(kind: "emit", name: action.name, payload: action.payload ?? .null)
            case "setPage":
                guard let pager = action.pager else { continue }
                let current = pages[pager] ?? 0
                let target: Int
                switch action.page {
                case .string("next"): target = current + 1
                case .string("prev"): target = current - 1
                default: target = action.page?.intValue ?? current
                }
                setPage(pager, target)
            case "setState":
                if let key = action.key, let value = action.value {
                    state[key] = value
                }
            case "dismiss":
                dismiss(reportEvent: true)
                return
            default:
                continue
            }
        }
    }

    func setPage(_ pager: String, _ target: Int) {
        guard let pageCount = pageCounts[pager], pageCount >= 1 else { return }
        let clamped = min(max(target, 0), pageCount - 1)
        guard pages[pager] != clamped else { return }
        pages[pager] = clamped
        emit(kind: "page_changed", name: pager, payload: .number(Double(clamped)))
    }

    func emit(kind: String, name: String?, payload: JSONValue) {
        guard let id = spec?.id else { return }
        let sequence = (sequences[id] ?? 0) + 1
        sequences[id] = sequence
        let encoder = JSONEncoder()
        let stateObject = (try? JSONSerialization.jsonObject(with: encoder.encode(state))) ?? [:]
        let payloadObject = (try? JSONSerialization.jsonObject(
            with: encoder.encode(payload),
            options: .fragmentsAllowed
        )) ?? NSNull()
        onEvent?([
            "type": "overlay_event",
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
            "id": id,
            "sequence": sequence,
            "kind": kind,
            "name": name as Any? ?? NSNull(),
            "payload": payloadObject,
            "state": stateObject,
            "pages": pages,
        ])
    }

    func status() -> [String: Any] {
        let stateObject = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(state))) ?? [:]
        return [
            "shown": spec != nil,
            "id": spec?.id as Any? ?? NSNull(),
            "pages": pages,
            "state": stateObject,
            "assets": assets.keys.sorted(),
        ]
    }

    func binding(forStateKey key: String) -> Binding<String> {
        Binding(
            get: { self.state[key]?.displayString ?? "" },
            set: { self.state[key] = .string($0) }
        )
    }
}
