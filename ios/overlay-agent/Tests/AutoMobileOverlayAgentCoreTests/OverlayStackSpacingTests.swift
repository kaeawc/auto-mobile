@testable import AutoMobileOverlayAgentCore
import XCTest

#if canImport(AppKit)
import AppKit
import SwiftUI

/// Measures the stack-spacing premise behind #10912 with a real SwiftUI layout pass on the macOS
/// host: a stack puts its explicit spacing around every child it is handed, an empty `ZStack`
/// included, so a hidden node must be left out of the stack (`drawnChildren`) rather than drawn
/// as nothing. The renderer's `NodeView` is UIKit-bound; this checks the same child filtering and
/// layout rules it relies on.
@MainActor
final class OverlayStackSpacingTests: XCTestCase {
    private let root: OverlayNode = {
        let json = """
        {"type": "column", "children": [
          {"type": "text", "text": "first"},
          {"type": "text", "text": "middle", "visibleWhen": {"key": "on", "equals": true}},
          {"type": "text", "text": "last"}
        ]}
        """
        return try! JSONDecoder().decode(OverlayNode.self, from: Data(json.utf8))
    }()

    private func height(_ view: some View) -> CGFloat {
        NSHostingView(rootView: view.frame(width: 100)).fittingSize.height
    }

    private func column(state: [String: JSONValue], filtered: Bool) -> some View {
        let node = root
        let holds = { (condition: Condition) in condition.holds(state) }
        return VStack(spacing: 20) {
            if filtered {
                ForEach(node.drawnChildren(holds: holds), id: \.offset) { _ in
                    Color.clear.frame(height: 10)
                }
            } else {
                ForEach(Array((node.children ?? []).enumerated()), id: \.offset) { _, child in
                    // The pre-#10912 shape: a stable container that is empty when hidden.
                    ZStack {
                        if child.visibleWhen.map(holds) ?? true { Color.clear.frame(height: 10) }
                    }
                }
            }
        }
    }

    func testAHiddenChildLeavesNoSpacingGapWhenTheParentFiltersIt() {
        XCTAssertEqual(height(column(state: [:], filtered: true)), 10 + 20 + 10)
        XCTAssertEqual(height(column(state: ["on": .bool(true)], filtered: true)), 10 + 20 + 10 + 20 + 10)
    }

    func testAnEmptyContainerStillCostsASpacingGap() {
        // The measured premise: three slots, two gaps, even though one slot is empty.
        XCTAssertEqual(height(column(state: [:], filtered: false)), 10 + 20 + 0 + 20 + 10)
    }
}
#endif
