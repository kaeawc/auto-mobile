import Foundation

/// Style `shimmer` (#14207): a sweep over a container's background, so only box, row, column and
/// card may set it, in `style` or any `styleWhen` entry. Checked on the authored tree with the
/// host's paths, as Android's `PrototypeLoadingStatesRules` does.
enum PrototypeLoadingStates {
    static let shimmerTypes: Set<String> = ["box", "row", "column", "card"]

    /// Seconds one sweep takes, as on Android.
    static let shimmerPeriod = 1.2

    /// Where the sweep's centre sits at `progress` (0...1): from one band-width before the start to
    /// one after the end, as Android's `prototypeShimmerCentre`.
    static func shimmerCentre(progress: Double, width: Double, band: Double) -> Double {
        -band + progress * (width + 2 * band)
    }

    /// The sweep's progress at `time` seconds: restarts every `shimmerPeriod`.
    static func shimmerProgress(at time: Double) -> Double {
        let phase = time.truncatingRemainder(dividingBy: shimmerPeriod)
        return (phase < 0 ? phase + shimmerPeriod : phase) / shimmerPeriod
    }

    static func validate(_ raw: JSONValue, path: String = "root") throws {
        guard case let .object(fields) = raw else { return }
        if let type = fields["type"]?.stringValue, !shimmerTypes.contains(type),
           let at = shimmerPath(fields, path: path)
        {
            throw DecodingError.dataCorrupted(.init(
                codingPath: [], debugDescription: "\(at): shimmer applies only to box, row, column and card"
            ))
        }
        if case let .array(children)? = fields["children"] {
            for (index, child) in children.enumerated() {
                try validate(child, path: "\(path).children[\(index)]")
            }
        }
        if let child = fields["child"] { try validate(child, path: "\(path).child") }
        for (screen, screenPath) in PrototypeStacks.screenChildren(in: fields, path: path) {
            try validate(screen, path: screenPath)
        }
    }

    private static func shimmerPath(_ fields: [String: JSONValue], path: String) -> String? {
        if fields["style"]?.objectFields?["shimmer"] != nil { return "\(path).style.shimmer" }
        guard case let .array(entries)? = fields["styleWhen"] else { return nil }
        return entries.indices.first { entries[$0].objectFields?["style"]?.objectFields?["shimmer"] != nil }
            .map { "\(path).styleWhen[\($0)].style.shimmer" }
    }
}
