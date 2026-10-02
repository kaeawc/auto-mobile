/// The observed app's axis, independent of XCUIDevice's remembered direction.
enum AppAxis: String, Equatable, Sendable {
    case portrait
    case landscape

    var value: Int { self == .portrait ? 0 : 1 }

    static func from(width: Int, height: Int) -> Self? {
        guard width > 0, height > 0, width != height else { return nil }
        return width > height ? .landscape : .portrait
    }

    static func from(orientation: String) -> Self? {
        switch orientation {
        case "portrait", "portrait_upside_down": .portrait
        case "landscape", "landscape_left", "landscape_right": .landscape
        default: nil
        }
    }
}

struct RotateTarget: Equatable, Sendable {
    let orientation: String
    let axis: AppAxis
    let isCoarse: Bool

    init?(_ request: String) {
        let normalized = request.lowercased()
        switch normalized {
        case "portrait": orientation = "portrait"
        case "landscape", "landscape_left", "landscapeleft": orientation = "landscape_left"
        case "landscape_right", "landscaperight": orientation = "landscape_right"
        case "portrait_upside_down", "portraitupsidedown": orientation = "portrait_upside_down"
        default: return nil
        }
        axis = orientation.hasPrefix("landscape") ? .landscape : .portrait
        isCoarse = normalized == "portrait" || normalized == "landscape"
    }
}

struct RotateResult: Equatable, Sendable {
    let previousOrientation: String
    let currentOrientation: String
    let value: Int
    let rotationPerformed: Bool
    let error: String?
}

enum RotateOutcome: Equatable, Sendable {
    case pending
    case noOp(RotateResult)
    case success(RotateResult)
    case failure(RotateResult)

    var result: RotateResult? {
        switch self {
        case .pending: nil
        case let .noOp(result), let .success(result), let .failure(result): result
        }
    }
}

/// Pure decisions for the initial reading and each subsequent poll reading.
struct RotateDecision: Sendable {
    static let pollIntervalMs: Int64 = 100
    static let timeoutMs: Int64 = 2000
    static let unchangedAxisError = "Rotation is not supported on this display (the screen size did not change)"

    let target: RotateTarget
    let appAxisBefore: AppAxis?
    let deviceBefore: String

    private var isCrossAxis: Bool {
        (appAxisBefore ?? AppAxis.from(orientation: deviceBefore)) != target.axis
    }

    static func reportedOrientation(appAxis: AppAxis?, device: String) -> String {
        let deviceAxis = AppAxis.from(orientation: device)
        if let appAxis, deviceAxis != appAxis { return appAxis.rawValue }
        return deviceAxis == nil ? "unknown" : device
    }

    func initial() -> RotateOutcome {
        let deviceAxis = AppAxis.from(orientation: deviceBefore)
        let matches: Bool
        if let appAxisBefore {
            matches = appAxisBefore == target.axis &&
                (target.isCoarse || (deviceAxis != nil && deviceBefore == target.orientation))
        } else {
            matches = deviceAxis != nil &&
                (deviceBefore == target.orientation || (target.isCoarse && deviceAxis == target.axis))
        }
        guard matches else { return .pending }
        return .noOp(result(appAxis: appAxisBefore, device: deviceBefore, performed: false))
    }

    /// A sequence is evaluated incrementally; unavailable app reads cannot prove an axis failure.
    func poll(appAxis: AppAxis?, device: String, deadlineReached: Bool) -> RotateOutcome {
        let verified: Bool
        if isCrossAxis, let appAxis {
            verified = appAxis == target.axis
        } else if isCrossAxis, appAxisBefore != nil, !deadlineReached {
            // Allow the optional app source to recover before trusting XCUIDevice alone.
            verified = false
        } else {
            verified = device == target.orientation
        }
        if verified { return .success(result(appAxis: appAxis, device: device, performed: true)) }
        guard deadlineReached else { return .pending }
        let error = isCrossAxis && appAxis != nil ? Self.unchangedAxisError :
            "Rotation to \(target.orientation) is not supported on this display"
        return .failure(result(appAxis: appAxis, device: device, performed: false, error: error))
    }

    private func result(
        appAxis: AppAxis?,
        device: String,
        performed: Bool,
        error: String? = nil
    )
        -> RotateResult
    {
        RotateResult(
            previousOrientation: Self.reportedOrientation(appAxis: appAxisBefore, device: deviceBefore),
            currentOrientation: Self.reportedOrientation(appAxis: appAxis, device: device),
            value: error == nil ? target.axis.value :
                (appAxis ?? appAxisBefore ?? AppAxis.from(orientation: deviceBefore))?.value ?? 0,
            rotationPerformed: performed,
            error: error
        )
    }
}
