@testable import CtrlProxy
import XCTest

/// A stale-context rejection names what changed since the host's observe (#19169).
final class FrameContextStaleReasonTests: XCTestCase {
    private func hierarchy(package: String = "com.test.app", child: String = "Row") -> ViewHierarchy {
        ViewHierarchy(
            updatedAt: 1,
            packageName: package,
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
                node: [UIElementInfo(text: child, className: "UILabel")]
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
    }

    func testAChangedSubtreeAndPackageAreNamed() throws {
        let frameContext = FrameContext()
        let issued = try XCTUnwrap(frameContext.issueContext(for: hierarchy()))
        XCTAssertEqual(frameContext.staleReason(expected: issued, hierarchy: hierarchy()), "contexts match")
        let reason = frameContext.staleReason(
            expected: issued,
            hierarchy: hierarchy(package: "com.other", child: "Other")
        )
        XCTAssertTrue(reason.hasPrefix("changed fields [hierarchy.node[0], packageName]; "), reason)
        XCTAssertTrue(reason.contains("first difference at hierarchy.node[0]"), reason)
        XCTAssertTrue(reason.contains(#""text":"Row""#) && reason.contains(#""text":"Other""#), reason)
    }

    func testANewerGenerationIsNamed() throws {
        let frameContext = FrameContext()
        let issued = try XCTUnwrap(frameContext.recordTransition(to: hierarchy()))
        frameContext.recordTransition(to: hierarchy(child: "Next"))
        frameContext.recordTransition(to: hierarchy())
        XCTAssertEqual(frameContext.staleReason(expected: issued, hierarchy: hierarchy()), "generation 1 -> 3")
    }

    func testAContextFromAnotherRunnerOrNotRetainedIsReported() throws {
        let other = try XCTUnwrap(FrameContext().issueContext(for: hierarchy()))
        let frameContext = FrameContext()
        XCTAssertTrue(
            frameContext.staleReason(expected: other, hierarchy: hierarchy())
                .contains("another runner session")
        )
        let epoch = try XCTUnwrap(frameContext.context(for: hierarchy())).split(separator: ":")[0]
        XCTAssertTrue(
            frameContext.staleReason(expected: "\(epoch):0:abc", hierarchy: hierarchy())
                .contains("issued hierarchy not retained")
        )
    }
}
