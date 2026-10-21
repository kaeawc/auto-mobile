import Foundation

protocol PrototypeViewerLayoutReading {
    func load(directory: URL) -> PrototypeSavedLoadResult
}

struct PrototypeViewerLayoutReader: PrototypeViewerLayoutReading {
    private let reader = PrototypeSavedLayoutReader()

    func load(directory: URL) -> PrototypeSavedLoadResult {
        reader.load(directory: directory)
    }
}

@MainActor
protocol PrototypeAssetRegistering {
    func registerImage(id: String, data: Data) -> Bool
    func registerFont(id: String, data: Data) -> String?
}

struct PrototypeViewerLaunch {
    let content: PrototypeViewerContent
    let registeredImageIds: [String]
    let fontFaces: [String: String]
    let problems: [PrototypeSavedProblem]
    var fromSavedLayout = false
}

struct PrototypeViewerLayoutLoader {
    static let documentsDirectoryName = "prototype"
    let reader: any PrototypeViewerLayoutReading
    let fallback: any PrototypeViewerContentLoading
    let registrar: any PrototypeAssetRegistering

    @MainActor
    func load(directory: URL) -> PrototypeViewerLaunch {
        switch reader.load(directory: directory) {
        case .notFound:
            return launch(fallback.load())
        case let .unsupportedFormat(version):
            return launch(.unsupportedFormat(version: version))
        case let .corrupt(message):
            return launch(.corrupt(message))
        case let .loaded(saved):
            if let path = saved.spec.root.unresolvedAnchorPath() {
                return launch(
                    .invalid(path: path, message: "Element anchors must be resolved to bounds by the host"),
                    problems: saved.problems
                )
            }
            let bytes: Int
            do {
                bytes = try prototypeViewerCompactSpecBytes(saved.specData)
            } catch {
                return launch(.corrupt(error.localizedDescription), problems: saved.problems)
            }
            guard bytes <= PrototypeLimits.maxSpecBytes else {
                return launch(.invalid(path: "$", message: "Spec byte limit exceeded"), problems: saved.problems)
            }
            return register(saved, specBytes: bytes)
        }
    }

    @MainActor
    private func register(_ saved: PrototypeSavedPrototype, specBytes: Int) -> PrototypeViewerLaunch {
        var images: [String] = []
        var fonts: [String: String] = [:]
        var problems = saved.problems
        for id in saved.assets.keys.sorted() {
            guard let asset = saved.assets[id] else { continue }
            let registered: Bool
            if asset.isFont {
                let face = registrar.registerFont(id: asset.id, data: asset.data)
                fonts[asset.id] = face
                registered = face != nil
            } else {
                registered = registrar.registerImage(id: asset.id, data: asset.data)
                if registered { images.append(asset.id) }
            }
            if !registered {
                problems.append(PrototypeSavedProblem(
                    assetId: asset.id, kind: .unreadable,
                    detail: asset.isFont ? "Font data could not be registered" : "Image data could not be decoded"
                ))
            }
        }
        problems.sort {
            ($0.assetId, $0.kind.rawValue) < ($1.assetId, $1.kind.rawValue)
        }
        return PrototypeViewerLaunch(
            content: .loaded(saved.spec, specBytes: specBytes),
            registeredImageIds: images, fontFaces: fonts, problems: problems, fromSavedLayout: true
        )
    }

    private func launch(
        _ content: PrototypeViewerContent, problems: [PrototypeSavedProblem] = []
    )
        -> PrototypeViewerLaunch
    {
        PrototypeViewerLaunch(content: content, registeredImageIds: [], fontFaces: [:], problems: problems)
    }
}

extension PrototypeSavedProblem {
    var wireObject: [String: String] {
        ["assetId": assetId, "kind": kind.rawValue, "detail": detail]
    }
}
