import Foundation

extension ElementLocator {
    struct FrameCandidate {
        let rawFrame: CGRect
        let screenFrame: CGRect
    }

    /// Walk the same roots and parent offsets used by hierarchy serialization.
    /// Alert roots start at offset zero because observe serializes them separately.
    nonisolated static func resolvedFrameCandidates<Node>(
        roots: [Node], frame: (Node) -> CGRect, children: (Node) -> [Node], matches: (Node) -> Bool
    )
        -> [FrameCandidate]
    {
        var result: [FrameCandidate] = []
        func visit(_ node: Node, enclosingFrame: CGRect?, offset: CGPoint) {
            let rawFrame = frame(node)
            let resolved = screenFrame(rawFrame, enclosingFrame: enclosingFrame, coordinateOffset: offset)
            if matches(node) {
                result.append(FrameCandidate(rawFrame: rawFrame, screenFrame: resolved.frame))
            }
            for child in children(node) {
                visit(child, enclosingFrame: resolved.frame, offset: resolved.offset)
            }
        }
        for root in roots {
            visit(root, enclosingFrame: nil, offset: .zero)
        }
        return result
    }

    nonisolated static func elementBounds(_ frame: CGRect) -> ElementBounds {
        ElementBounds(
            left: ElementBounds.clampedInt(frame.minX),
            top: ElementBounds.clampedInt(frame.minY),
            right: ElementBounds.clampedInt(frame.maxX),
            bottom: ElementBounds.clampedInt(frame.maxY)
        )
    }

    nonisolated static func matchingLiveIndex(
        frames: [CGRect], candidates: [FrameCandidate], target: ElementBounds
    )
        -> Int?
    {
        var unusedCandidates = Array(candidates.indices)
        let screenFrames = frames.map { liveFrame in
            guard let candidateIndex = unusedCandidates.min(by: { lhs, rhs in
                let lhsDistance = frameDistance(candidates[lhs], liveFrame)
                let rhsDistance = frameDistance(candidates[rhs], liveFrame)
                return lhsDistance == rhsDistance ? lhs < rhs : lhsDistance < rhsDistance
            }) else { return liveFrame }
            unusedCandidates.removeAll { $0 == candidateIndex }
            return candidates[candidateIndex].screenFrame
        }
        return matchingIndex(bounds: screenFrames.map(elementBounds), target: target)
    }

    /// Prefer candidates within 8 pt of the observed center. If all have moved
    /// farther, keep the nearest label match so a stale observation still acts.
    nonisolated static func matchingIndex(bounds: [ElementBounds], target: ElementBounds) -> Int? {
        bounds.indices.min { lhs, rhs in
            let lhsDistance = centerDistanceSquared(bounds[lhs], target)
            let rhsDistance = centerDistanceSquared(bounds[rhs], target)
            let lhsNear = lhsDistance <= 64
            let rhsNear = rhsDistance <= 64
            if lhsNear != rhsNear { return lhsNear }
            if lhsDistance != rhsDistance { return lhsDistance < rhsDistance }
            let lhsSize = sizeDifference(bounds[lhs], target)
            let rhsSize = sizeDifference(bounds[rhs], target)
            if lhsSize != rhsSize { return lhsSize < rhsSize }
            return lhs < rhs
        }
    }

    private nonisolated static func centerDistanceSquared(_ lhs: ElementBounds, _ rhs: ElementBounds) -> Int {
        let dx = (lhs.left + lhs.right) - (rhs.left + rhs.right)
        let dy = (lhs.top + lhs.bottom) - (rhs.top + rhs.bottom)
        return (dx * dx + dy * dy) / 4
    }

    private nonisolated static func sizeDifference(_ lhs: ElementBounds, _ rhs: ElementBounds) -> Int {
        abs(lhs.width - rhs.width) + abs(lhs.height - rhs.height)
    }

    nonisolated static func frameDistance(_ candidate: FrameCandidate, _ liveFrame: CGRect) -> Int {
        let live = elementBounds(liveFrame)
        return min(
            centerDistanceSquared(elementBounds(candidate.rawFrame), live),
            centerDistanceSquared(elementBounds(candidate.screenFrame), live)
        )
    }
}
