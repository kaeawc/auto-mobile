import XCTest

final class RotationOrientationTests: XCTestCase {
    func testGestureOrientationKeepsLandscapeSceneWhenDeviceIsFaceUp() {
        let orientation = DeviceRotation.gestureInterfaceOrientation(
            activeSceneOrientation: .landscapeLeft,
            sceneOrientation: .portrait,
            deviceOrientation: .faceUp
        )
        XCTAssertEqual(orientation, .landscapeLeft)
    }
}
