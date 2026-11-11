import UIKit
@preconcurrency import AVFoundation
import CoreImage
import CryptoKit
import ImageIO
import VisionKit

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = CameraViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

/// Discovery facts recorded once, one second after launch.
struct CameraFacts: Encodable {
    let iosVersion: String
    let discoverySessionDeviceCount: Int
    let defaultVideoDevicePresent: Bool
    let authorizationStatus: String
    let deviceInputCreated: Bool
    let sessionCanAddPhotoOutput: Bool
    let sessionCanAddMetadataOutput: Bool
    let imagePickerCameraAvailable: Bool
    let dataScannerSupported: Bool
    let dataScannerAvailable: Bool
}

struct PhotoReport: Encodable {
    var received = false
    var width = 0
    var height = 0
    var byteCount = 0
    var sha256: String?
    var error: String?

    private enum CodingKeys: String, CodingKey {
        case received, width, height, byteCount, sha256, error
    }

    // Absent values are written as null so every report has the same keys.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(received, forKey: .received)
        try container.encode(width, forKey: .width)
        try container.encode(height, forKey: .height)
        try container.encode(byteCount, forKey: .byteCount)
        try container.encode(sha256, forKey: .sha256)
        try container.encode(error, forKey: .error)
    }
}

/// `Documents/camera-report.json`: the discovery facts flattened beside the capture results.
struct CameraReport: Encodable {
    let facts: CameraFacts
    let complete: Bool
    let previewLayerHasContent: Bool
    let photo: PhotoReport
    let photoDecodedQr: [String]
    let metadataQrStrings: [String]
    let timestamp: String

    private enum CodingKeys: String, CodingKey {
        case complete, previewLayerHasContent, photo, photoDecodedQr, metadataQrStrings, timestamp
    }

    func encode(to encoder: Encoder) throws {
        try facts.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(complete, forKey: .complete)
        try container.encode(previewLayerHasContent, forKey: .previewLayerHasContent)
        try container.encode(photo, forKey: .photo)
        try container.encode(photoDecodedQr, forKey: .photoDecodedQr)
        try container.encode(metadataQrStrings, forKey: .metadataQrStrings)
        try container.encode(timestamp, forKey: .timestamp)
    }
}

@MainActor
final class CameraViewController: UIViewController, AVCapturePhotoCaptureDelegate, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let metadataOutput = AVCaptureMetadataOutput()
    private let sessionQueue = DispatchQueue(label: "dev.automobile.camerafixture.session")
    private let status = UILabel()
    private var preview: AVCaptureVideoPreviewLayer!
    private var complete = false
    private var metadataStrings: [String] = []
    private var photoReport = PhotoReport()
    private var decodedQR: [String] = []
    private var facts: CameraFacts?
    private var inputCreated = false
    private var canAddPhoto = false
    private var canAddMetadata = false
    private var photoAdded = false

    private var documents: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        status.textColor = .white
        status.backgroundColor = UIColor.black.withAlphaComponent(0.7)
        status.font = .monospacedSystemFont(ofSize: 13, weight: .medium)
        status.numberOfLines = 0
        status.text = "CameraFixture: waiting for discovery"
        view.addSubview(status)
        configureCamera()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.recordDiscovery()
            self?.writeReport()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            guard let self else { return }
            self.complete = true
            self.writeReport()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview.frame = view.bounds
        status.frame = CGRect(x: 12, y: view.safeAreaInsets.top + 12,
                              width: view.bounds.width - 24, height: 110)
    }

    private func configureCamera() {
        // Query these even on stock Simulator, where discovery returns no device.
        canAddPhoto = session.canAddOutput(photoOutput)
        canAddMetadata = session.canAddOutput(metadataOutput)
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            photoReport.error = "No video capture device"
            return
        }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            inputCreated = true
            guard session.canAddInput(input) else {
                photoReport.error = "Session cannot add device input"
                return
            }
            session.beginConfiguration()
            session.sessionPreset = .photo
            session.addInput(input)
            canAddPhoto = session.canAddOutput(photoOutput)
            if canAddPhoto {
                session.addOutput(photoOutput)
                photoAdded = true
            }
            canAddMetadata = session.canAddOutput(metadataOutput)
            if canAddMetadata {
                session.addOutput(metadataOutput)
                metadataOutput.setMetadataObjectsDelegate(self, queue: .main)
                if metadataOutput.availableMetadataObjectTypes.contains(.qr) {
                    metadataOutput.metadataObjectTypes = [.qr]
                }
            }
            session.commitConfiguration()
            // startRunning can block; never run the real implementation on main.
            let captureSession = session
            sessionQueue.async { [weak self] in
                captureSession.startRunning()
                DispatchQueue.main.async {
                    guard let self, captureSession.isRunning else { return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                        guard let self, self.photoAdded else { return }
                        self.photoOutput.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
                    }
                }
            }
        } catch {
            photoReport.error = error.localizedDescription
        }
    }

    private func recordDiscovery() {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .builtInUltraWideCamera, .builtInTelephotoCamera],
            mediaType: .video, position: .unspecified)
        let authorization = AVCaptureDevice.authorizationStatus(for: .video)
        let authorizationName: String
        switch authorization {
        case .authorized: authorizationName = "authorized"
        case .denied: authorizationName = "denied"
        case .restricted: authorizationName = "restricted"
        case .notDetermined: authorizationName = "notDetermined"
        @unknown default: authorizationName = "unknown"
        }
        var scannerSupported = false
        var scannerAvailable = false
        if #available(iOS 16.0, *) {
            scannerSupported = DataScannerViewController.isSupported
            scannerAvailable = DataScannerViewController.isAvailable
        }
        facts = CameraFacts(
            iosVersion: UIDevice.current.systemVersion,
            discoverySessionDeviceCount: discovery.devices.count,
            defaultVideoDevicePresent: AVCaptureDevice.default(for: .video) != nil,
            authorizationStatus: authorizationName,
            deviceInputCreated: inputCreated,
            sessionCanAddPhotoOutput: canAddPhoto,
            sessionCanAddMetadataOutput: canAddMetadata,
            imagePickerCameraAvailable: UIImagePickerController.isSourceTypeAvailable(.camera),
            dataScannerSupported: scannerSupported,
            dataScannerAvailable: scannerAvailable)
    }

    private func writeReport() {
        guard let facts else { return } // The first full report is at one second.
        let report = CameraReport(
            facts: facts,
            complete: complete,
            // This intentionally follows the PoC's specified heuristic; running alone
            // does not prove that pixels reached a screen.
            previewLayerHasContent: preview.contents != nil || session.isRunning,
            photo: photoReport,
            photoDecodedQr: decodedQR,
            metadataQrStrings: metadataStrings,
            timestamp: ISO8601DateFormatter().string(from: Date()))
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(report)
            try data.write(to: documents.appendingPathComponent("camera-report.json"), options: .atomic)
            status.text = "CameraFixture: \(complete ? "complete" : "recording")\n"
                + "devices: \(facts.discoverySessionDeviceCount)  photo: \(photoReport.received)\n"
                + "QR callbacks: \(metadataStrings.count)"
        } catch {
            status.text = "Report write failed: \(error.localizedDescription)"
        }
    }

    nonisolated func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto,
                                error: Error?) {
        let data = photo.fileDataRepresentation()
        let message = error?.localizedDescription
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.photoReport.received = true
            self.photoReport.error = message ?? (data == nil ? "No photo data" : nil)
            if let data {
                self.photoReport.byteCount = data.count
                self.photoReport.sha256 = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                if let source = CGImageSourceCreateWithData(data as CFData, nil),
                   let image = CGImageSourceCreateImageAtIndex(source, 0, nil) {
                    self.photoReport.width = image.width
                    self.photoReport.height = image.height
                    let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil,
                                              options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
                    self.decodedQR = (detector?.features(in: CIImage(cgImage: image)) ?? [])
                        .compactMap { ($0 as? CIQRCodeFeature)?.messageString }
                }
                do {
                    try data.write(to: self.documents.appendingPathComponent("camera-photo.png"), options: .atomic)
                } catch {
                    self.photoReport.error = "Photo write failed: \(error.localizedDescription)"
                }
            }
            self.writeReport()
        }
    }

    nonisolated func photoOutput(_ output: AVCapturePhotoOutput,
                                didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
        guard let message = error?.localizedDescription else { return }
        DispatchQueue.main.async { [weak self] in
            self?.photoReport.error = message
            self?.writeReport()
        }
    }

    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                                   from connection: AVCaptureConnection) {
        let strings = metadataObjects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.complete else { return }
            self.metadataStrings.append(contentsOf: strings)
            self.writeReport()
        }
    }
}
