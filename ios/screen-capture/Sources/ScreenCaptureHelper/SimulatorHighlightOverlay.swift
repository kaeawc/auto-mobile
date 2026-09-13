import AppKit
import ApplicationServices
import AutoMobileHighlightCore
import ScreenCaptureCore

struct SimulatorHighlightRequest: Decodable {
    let requestId: String
    let id: String
    let shape: SimulatorHighlightShape
}

typealias SimulatorHighlightShape = CircleHighlight

/// Uses the Simulator's accessibility display group, not its bezel or toolbar.
/// This requires host Accessibility access, but no code in the simulated app.
struct SimulatorOverlayTarget {
    let windowID: UInt32
    let processID: pid_t
    let frame: CGRect
    let title: String?
}

enum SimulatorDisplayGeometry {
    static func targets() -> [SimulatorOverlayTarget] {
        let simulatorPIDs = Set(
            NSRunningApplication
                .runningApplications(withBundleIdentifier: simulatorBundleIdentifier).map(\.processIdentifier)
        )
        let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] ?? []
        return windows.compactMap { window in
            guard let pid = window[kCGWindowOwnerPID as String] as? Int32, simulatorPIDs.contains(pid),
                  let id = window[kCGWindowNumber as String] as? UInt32,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
            return SimulatorOverlayTarget(
                windowID: id,
                processID: pid,
                frame: frame,
                title: window[kCGWindowName as String] as? String
            )
        }
    }

    static func find(deviceName: String) throws -> SimulatorOverlayTarget {
        let matches = targets().filter { simulatorWindowTitle($0.title, namesDevice: deviceName) }
        guard matches.count == 1 else {
            throw OverlayError(
                "Expected one visible Simulator window named \(deviceName), found \(matches.count). Open that Simulator and close duplicate windows."
            )
        }
        return matches[0]
    }

    static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    static func frame(_ element: AXUIElement) -> CGRect? {
        guard let position = attribute(element, kAXPositionAttribute),
              let size = attribute(element, kAXSizeAttribute),
              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var dimensions = CGSize.zero
        // Core Foundation bridging requires a cast after the type-ID guards above.
        // swiftlint:disable force_cast
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
              AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
        // swiftlint:enable force_cast
        return CGRect(origin: point, size: dimensions)
    }

    static func displayFrame(window: SimulatorOverlayTarget) -> CGRect? {
        let app = AXUIElementCreateApplication(window.processID)
        let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
        let matching = windows.filter { element in
            guard let rect = frame(element) else { return false }
            return abs(rect.minX - window.frame.minX) < 2 && abs(rect.minY - window.frame.minY) < 2
                && abs(rect.width - window.frame.width) < 2 && abs(rect.height - window.frame.height) < 2
        }
        guard matching.count == 1 else { return nil }
        let children = attribute(matching[0], kAXChildrenAttribute) as? [AXUIElement] ?? []
        let groups = children.filter { attribute($0, kAXRoleAttribute) as? String == kAXGroupRole }
            .compactMap(frame).filter { $0.width > 50 && $0.height > 50 && window.frame.contains($0) }
        guard groups.count == 1 else { return nil }
        return groups[0]
    }

    static func appKitFrame(_ rect: CGRect, primaryScreenHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryScreenHeight - rect.maxY, width: rect.width, height: rect.height)
    }
}

/// A non-interactive panel positioned in host coordinates over the simulated display.
@MainActor
protocol SimulatorOverlay: AnyObject {
    func refresh() async throws
    func close()
}

@MainActor
final class SimulatorHighlightOverlay: SimulatorOverlay {
    static func title(windowID: UInt32) -> String {
        "AutoMobile Highlight \(windowID)"
    }

    private let panel: NSPanel
    private let shape: SimulatorHighlightShape
    private let targetID: UInt32
    private let targetPID: pid_t
    private let layer = HandDrawnCircleLayer()
    private let startedAt = ProcessInfo.processInfo.systemUptime
    private var previousFrame: CGRect?

    init(window: SimulatorOverlayTarget, request: SimulatorHighlightRequest) throws {
        guard !request.id.isEmpty, AXIsProcessTrusted(),
              let frame = SimulatorDisplayGeometry.displayFrame(window: window),
              request.shape.bounds.scaled(to: frame.size) != nil
        else {
            throw OverlayError(
                "Cannot locate Simulator display or invalid highlight coordinates. Grant Accessibility access to the capture helper and provide bounds.sourceWidth/sourceHeight."
            )
        }
        targetID = window.windowID
        targetPID = window.processID
        shape = request.shape
        panel = NSPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = Self.title(windowID: targetID)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let view = NSView()
        view.wantsLayer = true
        panel.contentView = view
        view.layer?.addSublayer(layer)
        update(frame: frame)
    }

    func refresh() async throws {
        guard let window = SimulatorDisplayGeometry.targets()
            .first(where: { $0.windowID == targetID && $0.processID == targetPID }),
            let frame = SimulatorDisplayGeometry.displayFrame(window: window)
        else {
            throw OverlayError("Simulator window disappeared")
        }
        update(frame: frame)
    }

    func close() {
        panel.close()
    }

    private func update(frame: CGRect) {
        let rect = SimulatorDisplayGeometry.appKitFrame(
            frame,
            primaryScreenHeight: CGDisplayBounds(CGMainDisplayID()).height
        )
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if previousFrame != frame {
            panel.setFrame(rect, display: true)
        }
        if previousFrame?.size != frame.size, let bounds = shape.bounds.scaled(to: frame.size) {
            layer.bounds = CGRect(origin: .zero, size: frame.size)
            layer.position = CGPoint(x: frame.width / 2, y: frame.height / 2)
            layer.configure(rect: bounds, strokeScale: bounds.width / CGFloat(shape.bounds.width))
            layer.setAffineTransform(CGAffineTransform(scaleX: 1, y: -1))
        }
        previousFrame = frame
        layer.update(elapsed: ProcessInfo.processInfo.systemUptime - startedAt)
        CATransaction.commit()
        panel.order(.above, relativeTo: Int(targetID))
        panel.displayIfNeeded()
        CATransaction.flush()
    }
}

/// One process per Simulator stays alive while its daemon holds stdin open.
/// ScreenCaptureKit retains connections to included applications even after a
/// filter update removes their windows, so an overlay TTL must not exit the app.
@MainActor
final class SimulatorHighlightHost {
    typealias OverlayFactory = (SimulatorHighlightRequest) async throws -> SimulatorOverlay
    private var overlays: [String: (overlay: SimulatorOverlay, deadline: TimeInterval)] = [:]
    private var buffer = Data()
    private let now: () -> TimeInterval
    private let makeOverlay: OverlayFactory
    private let replySink: (SimulatorHighlightReply) -> Void
    private var inputTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private let waitForFrame: () async throws -> Void

    init(
        deviceName: String,
        now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        makeOverlay: OverlayFactory? = nil,
        waitForFrame: @escaping () async throws -> Void = { try await Task.sleep(nanoseconds: 16_666_667) },
        replySink: @escaping (SimulatorHighlightReply) -> Void = { reply in
            if let data = try? JSONEncoder().encode(reply) {
                FileHandle.standardOutput.write(data + Data([10]))
            }
        }
    ) {
        self.waitForFrame = waitForFrame
        self.now = now
        self.replySink = replySink
        self.makeOverlay = makeOverlay ?? { request in
            let window = try SimulatorDisplayGeometry.find(deviceName: deviceName)
            return try SimulatorHighlightOverlay(window: window, request: request)
        }
    }

    func receive(_ data: Data) async {
        do {
            let request = try JSONDecoder().decode(SimulatorHighlightRequest.self, from: data)
            do {
                let overlay = try await makeOverlay(request)
                overlays.removeValue(forKey: request.id)?.overlay.close()
                overlays[request.id] = (overlay, now() + HandDrawnCircle.duration)
                startRefreshing()
                reply(requestId: request.requestId, error: nil)
            } catch { reply(requestId: request.requestId, error: String(describing: error)) }
        } catch {
            FileHandle.standardError.write(Data("error: invalid highlight command: \(error)\n".utf8))
        }
    }

    func enqueue(_ data: Data) {
        let previous = inputTask
        inputTask = Task {
            await previous?.value
            guard !Task.isCancelled else { return }
            await ingest(data)
        }
    }

    func ingest(_ data: Data) async {
        buffer.append(data)
        guard buffer.count <= 1_048_576 else { buffer.removeAll(); return }
        while let newline = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            await receive(line)
        }
    }

    private func startRefreshing() {
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            defer { refreshTask = nil }
            while !overlays.isEmpty, !Task.isCancelled {
                do { try await waitForFrame() } catch { return }
                guard !Task.isCancelled else { return }
                await refresh()
            }
        }
    }

    func refresh() async {
        for (id, entry) in overlays {
            if now() >= entry.deadline {
                entry.overlay.close()
                overlays.removeValue(forKey: id)
            } else {
                do { try await entry.overlay.refresh() }
                catch {
                    entry.overlay.close()
                    if overlays[id]?.overlay === entry.overlay {
                        overlays.removeValue(forKey: id)
                    }
                }
            }
        }
    }

    func close() {
        inputTask?.cancel()
        refreshTask?.cancel()
        for entry in overlays.values {
            entry.overlay.close()
        }
        overlays.removeAll()
    }

    private func reply(requestId: String, error: String?) {
        replySink(SimulatorHighlightReply(requestId: requestId, success: error == nil, error: error))
    }
}

struct SimulatorHighlightReply: Encodable {
    let requestId: String
    let success: Bool
    let error: String?
}

struct OverlayError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) {
        self.description = description
    }
}
