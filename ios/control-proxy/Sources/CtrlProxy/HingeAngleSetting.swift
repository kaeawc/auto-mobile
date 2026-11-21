public protocol HingeAngleSetting: Sendable {
    func setHingeAngle(_ degrees: Double) async throws
}

/// Device orientations the simulator's device-state relay accepts (#17047). It has no
/// upside-down value, the same set as the simulator's own orientation picker.
public enum SimulatedDeviceOrientation: String, Equatable, Sendable {
    case portrait
    case landscapeLeft = "landscape-left"
    case landscapeRight = "landscape-right"
}

/// Posts a device orientation to the simulator's CoreMotion device-state relay. On a foldable,
/// SpringBoard rotates each panel from this pose orientation and ignores XCUIDevice (#17047).
public protocol SimulatedOrientationSetting: Sendable {
    func setDeviceOrientation(_ orientation: SimulatedDeviceOrientation) async throws
}
