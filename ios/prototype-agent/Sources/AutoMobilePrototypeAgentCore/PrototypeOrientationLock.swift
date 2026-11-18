/// The scene's interface orientation, independent of UIKit and physical device orientation.
enum PrototypeOrientationBaseline: String {
    case portrait, portraitUpsideDown, landscapeLeft, landscapeRight, unknown
}

@MainActor
protocol PrototypeOrientationDriver: AnyObject {
    var baseline: PrototypeOrientationBaseline { get }
    func applyLock(_ orientation: PrototypeWindowOrientation)
    /// Unknown restores only the host's supported-orientations policy.
    func restoreBaseline(_ baseline: PrototypeOrientationBaseline)
}

/// One coordinator per scene. Reacquiring moves an owner to the top without replacing the baseline.
@MainActor
final class PrototypeOrientationLock {
    private let driver: any PrototypeOrientationDriver
    private var baseline: PrototypeOrientationBaseline?
    private var owners: [(owner: ObjectIdentifier, orientation: PrototypeWindowOrientation)] = []

    var isEmpty: Bool { owners.isEmpty }

    init(driver: any PrototypeOrientationDriver) { self.driver = driver }

    func acquire(owner: ObjectIdentifier, orientation: PrototypeWindowOrientation) {
        if owners.isEmpty { baseline = driver.baseline }
        owners.removeAll { $0.owner == owner }
        owners.append((owner, orientation))
        driver.applyLock(orientation)
    }

    func release(owner: ObjectIdentifier) {
        guard owners.contains(where: { $0.owner == owner }) else { return }
        owners.removeAll { $0.owner == owner }
        if let effective = owners.last {
            driver.applyLock(effective.orientation)
        } else if let baseline {
            self.baseline = nil
            driver.restoreBaseline(baseline)
        }
    }
}
