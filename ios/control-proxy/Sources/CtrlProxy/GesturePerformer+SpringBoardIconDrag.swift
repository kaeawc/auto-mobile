import Foundation
#if canImport(XCTest) && os(iOS)
    import XCTest

    extension GesturePerformer {
        /// Refuses a drag whose first point is on a hittable SpringBoard icon (home screen grid or
        /// dock, also when the dock is shown over an app), before any input (#18859). The runner is
        /// the one place that sees SpringBoard live: the host's observation holds only the
        /// foreground app's tree, so a dock shown over an app is absent from it.
        ///
        /// Detection failures keep the drag: a missed refusal only restores the old behaviour,
        /// while a wrong one would block a drag that works.
        func refuseSpringBoardIconDragStart(x: Double, y: Double) throws {
            GesturePhaseDiagnostics.current?.begin("springBoardIconCheck")
            let point = CGPoint(x: x, y: y)
            guard let snapshot = catchingObjCExceptionNonThrowing({ try? self.springboard.snapshot() }, fallback: nil)
            else {
                logger.debug("springboard snapshot unavailable; drag start check skipped")
                return
            }
            var icons: [SpringBoardIconHit.Icon] = []
            var pending: [XCUIElementSnapshot] = [snapshot]
            while let node = pending.popLast() {
                if node.elementType == .icon {
                    icons.append(.init(identifier: node.identifier, label: node.label, frame: node.frame))
                }
                pending.append(contentsOf: node.children)
            }
            for candidate in SpringBoardIconHit.candidates(at: point, in: icons).prefix(3) {
                let hittable = catchingObjCExceptionNonThrowing({
                    self.springboard.icons
                        .matching(NSPredicate(
                            format: "identifier == %@ AND label == %@", candidate.identifier, candidate.label
                        ))
                        .allElementsBoundByIndex
                        .contains { $0.isHittable && $0.frame.contains(point) }
                }, fallback: false)
                if hittable {
                    throw GestureError.springBoardIconDrag(icon: SpringBoardIconHit.displayName(candidate))
                }
            }
        }
    }
#endif
