import Foundation
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

enum PrototypeViewerEndpoint {
    static let relativePath = "Library/AutoMobile/prototype-endpoint.json"

    enum Failure: Error, Equatable {
        case notJSON
        case missingPort
        case invalidPort
        case missingToken
        case tokenTooShort
    }

    private struct Record: Codable {
        let port: UInt16
        let token: String

        init(port: UInt16, token: String) {
            self.port = port
            self.token = token
        }

        init(from decoder: any Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            guard values.contains(.port) else { throw Failure.missingPort }
            guard let port = try? values.decode(UInt16.self, forKey: .port), port > 0 else {
                throw Failure.invalidPort
            }
            guard let token = try? values.decode(String.self, forKey: .token), !token.isEmpty else {
                throw Failure.missingToken
            }
            guard token.count >= PrototypeAgentProtocol.minimumTokenLength else { throw Failure.tokenTooShort }
            self.init(port: port, token: token)
        }
    }

    static func encode(port: UInt16, token: String) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        // A record contains only a finite integer and a String; encoding cannot fail.
        do {
            return try encoder.encode(Record(port: port, token: token))
        } catch {
            preconditionFailure("Could not encode prototype endpoint")
        }
    }

    static func decode(_ data: Data) -> Result<(port: UInt16, token: String), Failure> {
        do {
            let record = try JSONDecoder().decode(Record.self, from: data)
            return .success((record.port, record.token))
        } catch let failure as Failure {
            return .failure(failure)
        } catch {
            return .failure(.notJSON)
        }
    }
}

protocol PrototypeTokenSource {
    func makeToken() -> String
}

struct SecurePrototypeTokenSource: PrototypeTokenSource {
    func makeToken() -> String {
        var generator = SystemRandomNumberGenerator()
        return (0 ..< 32).map { _ in
            String(format: "%02x", UInt8.random(in: .min ... .max, using: &generator))
        }.joined()
    }
}

protocol PrototypeEndpointFiles {
    func writeAtomically(_ data: Data, to path: String, mode: UInt16) throws
    func remove(path: String) throws
}

struct FoundationPrototypeEndpointFiles: PrototypeEndpointFiles {
    private let fileManager: FileManager

    init(fileManager: FileManager = .default) { self.fileManager = fileManager }

    func writeAtomically(_ data: Data, to path: String, mode: UInt16) throws {
        let destination = URL(fileURLWithPath: path)
        let directory = destination.deletingLastPathComponent()
        try fileManager.createDirectory(
            at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
        )
        let temporary = directory.appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString)")
        var descriptor = open(temporary.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, mode_t(mode))
        guard descriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { try? fileManager.removeItem(at: temporary) }
        defer { if descriptor >= 0 { _ = close(descriptor) } }
        try data.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return }
            var written = 0
            while written < bytes.count {
                let writeResult = write(descriptor, baseAddress.advanced(by: written), bytes.count - written)
                if writeResult < 0, errno == EINTR { continue }
                guard writeResult > 0 else {
                    throw POSIXError(writeResult == 0 ? .EIO : (POSIXErrorCode(rawValue: errno) ?? .EIO))
                }
                written += writeResult
            }
        }
        guard fsync(descriptor) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let closeResult = close(descriptor)
        descriptor = -1
        guard closeResult == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        // POSIX rename replaces a stale file in one step and preserves the temp file's 0600
        // permissions. Removing the old destination first would expose a publication gap.
        guard rename(temporary.path, destination.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

    func remove(path: String) throws {
        do {
            try fileManager.removeItem(atPath: path)
        } catch let error as CocoaError where error.code == .fileNoSuchFile {
            // Already retracted, including a launch that never became ready.
        }
    }
}

final class PrototypeEndpointPublisher {
    let token: String
    private let path: String
    private let files: any PrototypeEndpointFiles
    private var retracted = false

    init(
        root: String,
        files: any PrototypeEndpointFiles = FoundationPrototypeEndpointFiles(),
        tokens: any PrototypeTokenSource = SecurePrototypeTokenSource()
    ) {
        token = tokens.makeToken()
        path = URL(fileURLWithPath: root).appendingPathComponent(PrototypeViewerEndpoint.relativePath).path
        self.files = files
    }

    func publish(port: UInt16) throws {
        guard port > 0 else { throw PrototypeViewerEndpoint.Failure.invalidPort }
        try files.writeAtomically(PrototypeViewerEndpoint.encode(port: port, token: token), to: path, mode: 0o600)
        retracted = false
    }

    func retract() {
        guard !retracted else { return }
        do {
            try files.remove(path: path)
            retracted = true
        } catch {
            NSLog(
                "[AutoMobilePrototypeAgent] could not remove viewer endpoint (error code %ld)",
                (error as NSError).code
            )
        }
    }
}

enum PrototypeViewerHostCapabilities {
    static func advertised(_ base: [String]) -> [String] {
        base.filter {
            $0 != PrototypeAgentProtocol.hideForCaptureRequest &&
                $0 != PrototypeAgentProtocol.restoreAfterCaptureRequest &&
                $0 != PrototypeAgentProtocol.screenshotHideCapability
        }
    }
}

struct PrototypeViewerSaveBack {
    private let savedSpecId: String?
    private let layoutDirectory: URL
    private let files: any PrototypeEndpointFiles
    private let layoutExists: (URL) -> Bool

    init(
        savedSpecId: String?, layoutDirectory: URL,
        files: any PrototypeEndpointFiles = FoundationPrototypeEndpointFiles(),
        layoutExists: @escaping (URL) -> Bool = {
            FileManager.default.fileExists(atPath: $0.appendingPathComponent(PrototypeSavedLayout.manifestName).path)
        }
    ) {
        self.savedSpecId = savedSpecId
        self.layoutDirectory = layoutDirectory
        self.files = files
        self.layoutExists = layoutExists
    }

    @discardableResult
    func persistIfSaved(specId: String, specJSON: Any) -> Bool {
        guard specId == savedSpecId, layoutExists(layoutDirectory) else { return false }
        guard JSONSerialization.isValidJSONObject([specJSON]) else {
            NSLog("[AutoMobilePrototypeAgent] could not save invalid viewer JSON")
            return false
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: specJSON, options: .fragmentsAllowed)
            guard data.count <= PrototypeSavedLayoutLimits().maxSpecBytes else { return false }
            try files.writeAtomically(
                data, to: layoutDirectory.appendingPathComponent(PrototypeSavedLayout.specName).path, mode: 0o600
            )
            return true
        } catch {
            NSLog(
                "[AutoMobilePrototypeAgent] could not save viewer prototype (error code %ld)",
                (error as NSError).code
            )
            return false
        }
    }
}
