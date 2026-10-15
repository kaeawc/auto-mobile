public protocol HingeAngleSetting: Sendable {
    func setHingeAngle(_ degrees: Double) async throws
}
