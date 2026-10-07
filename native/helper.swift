// ciq-sim-helper: the native half of owl-connectiq-simulator-mcp.
//
// Two ways to run it, same commands and same JSON either way:
//
//     ciq-sim-helper <command> ['<json arguments>']     one command, then exit
//     ciq-sim-helper serve                              one JSON request per line on
//                                                       stdin: {"id":1,"command":"status","args":{}}
//
// Success is `{"ok":true,...}`; failure is
// `{"ok":false,"error":{"code":"...","message":"..."}}` (exit status 1 in
// one-shot mode). `serve` exists because the text recognition model takes many
// seconds to load in a fresh process and milliseconds afterwards.
//
// It exists because the Connect IQ simulator has no remote-control protocol for
// input or screenshots: its TCP shell (port 1234) only pushes files and starts
// apps. Everything here goes through macOS instead, chosen so that none of it
// needs the simulator to be frontmost, the cursor to move, or the screen to be
// unlocked:
//
//   capture   ScreenCaptureKit (or /usr/sbin/screencapture) reads the window's
//             own backing store, so it works while the window is covered.
//   mouse     CGEvents posted straight to the simulator's pid. They never pass
//             through the window server's hit-testing, so the real cursor stays
//             where it is.
//   menu, ui  The Accessibility API (menus and dialogs are ordinary AppKit).
//
//   key       CGEvents posted to the pid and addressed to one window, used to
//             type into dialogs when Accessibility cannot (see below).
//
// What a locked screen changes, and how each case is handled:
//   - Accessibility hides every window's contents (menus still work), so
//     windows are found through the window server and dialogs are driven with
//     screenshots, clicks and typed keys instead of element actions.
//   - A sleeping display cannot be captured, so it is woken first. Waking it
//     shows the lock screen; it does not unlock anything.

import ApplicationServices
import Cocoa
import IOKit.pwr_mgt
import ScreenCaptureKit
import Vision

let simulatorBundleId = "com.garmin.connectiq.simulator"
let helperVersion = 2

// MARK: - Output

struct Failure: Error {
    let code: String
    let message: String
    var extra: [String: Any] = [:]
}

func writeJSON(_ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
        ?? Data("{\"ok\":false,\"error\":{\"code\":\"internal\",\"message\":\"unserialisable result\"}}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func finish(_ result: [String: Any]) -> Never {
    var out = result
    out["ok"] = true
    writeJSON(out)
    exit(0)
}

func finish(_ failure: Failure) -> Never {
    var error: [String: Any] = failure.extra
    error["code"] = failure.code
    error["message"] = failure.message
    writeJSON(["ok": false, "error": error])
    exit(1)
}

// MARK: - Arguments

struct Args {
    let raw: [String: Any]

    func string(_ key: String) -> String? { raw[key] as? String }
    func double(_ key: String) -> Double? { (raw[key] as? NSNumber)?.doubleValue }
    func int(_ key: String) -> Int? { (raw[key] as? NSNumber)?.intValue }
    func bool(_ key: String) -> Bool? { raw[key] as? Bool }
    func dict(_ key: String) -> Args? { (raw[key] as? [String: Any]).map(Args.init) }
    func list(_ key: String) -> [Any]? { raw[key] as? [Any] }

    func need<T>(_ key: String, _ value: T?) throws -> T {
        guard let value else { throw Failure(code: "bad_arguments", message: "missing or invalid argument '\(key)'") }
        return value
    }
}

// MARK: - Accessibility helpers

func axValue(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: AnyObject?
    let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    return status == .success ? value : nil
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    axValue(element, attribute) as? String
}

func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
    (axValue(element, attribute) as? NSNumber)?.boolValue
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axValue(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func axActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return names as? [String] ?? []
}

func axFrame(_ element: AXUIElement) -> CGRect? {
    guard let position = axValue(element, kAXPositionAttribute), let size = axValue(element, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
    else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent)
    else { return nil }
    return CGRect(origin: point, size: extent)
}

func axErrorName(_ error: AXError) -> String {
    switch error {
    case .success: return "success"
    case .failure: return "failure"
    case .illegalArgument: return "illegalArgument"
    case .invalidUIElement: return "invalidUIElement"
    case .invalidUIElementObserver: return "invalidUIElementObserver"
    case .cannotComplete: return "cannotComplete"
    case .attributeUnsupported: return "attributeUnsupported"
    case .actionUnsupported: return "actionUnsupported"
    case .notificationUnsupported: return "notificationUnsupported"
    case .notImplemented: return "notImplemented"
    case .apiDisabled: return "apiDisabled"
    case .noValue: return "noValue"
    default: return "error \(error.rawValue)"
    }
}

/// Private but long-lived: maps an accessibility window to its window-server id.
typealias AXGetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
let axGetWindow: AXGetWindowFn? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(symbol, to: AXGetWindowFn.self)
}()

func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
        throw Failure(
            code: "accessibility_denied",
            message: "Accessibility permission is missing. Grant it to the app that launches this MCP server "
                + "(your terminal, IDE or Claude) in System Settings > Privacy & Security > Accessibility, then restart that app.")
    }
}

// MARK: - Simulator discovery

struct WindowInfo {
    var id: CGWindowID
    var title: String
    var frame: CGRect
    var role: String
    var subrole: String
    var minimized: Bool
    var modal: Bool
    var element: AXUIElement?

    var isDeviceWindow: Bool { subrole == "AXStandardWindow" }

    var json: [String: Any] {
        [
            "id": Int(id), "title": title, "role": role, "subrole": subrole,
            "minimized": minimized, "modal": modal, "kind": isDeviceWindow ? "device" : "dialog",
            "inspectable": element != nil,
            "x": frame.origin.x, "y": frame.origin.y, "width": frame.width, "height": frame.height,
        ]
    }
}

/// Finds the simulator by executable path, from the kernel's process list.
/// (NSWorkspace's list is only kept current by a running AppKit event loop,
/// which a long-lived `serve` process does not have.)
func simulatorPid() -> pid_t? {
    let count = proc_listallpids(nil, 0)
    guard count > 0 else { return nil }
    var pids = [pid_t](repeating: 0, count: Int(count) + 64)
    let filled = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
    var path = [CChar](repeating: 0, count: 4096)
    for pid in pids.prefix(Int(max(filled, 0))) where pid > 0 {
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { continue }
        if String(cString: path).hasSuffix("/ConnectIQ.app/Contents/MacOS/simulator") { return pid }
    }
    return nil
}

func simulatorApp(_ args: Args) throws -> NSRunningApplication {
    let pid = args.int("pid").map { pid_t($0) } ?? simulatorPid()
    guard let pid, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
        throw Failure(code: "simulator_not_running", message: "The Connect IQ simulator is not running.")
    }
    return app
}

/// The window server's view of the simulator's windows; needs no permission.
func cgWindows(pid: pid_t) -> [(id: CGWindowID, frame: CGRect, title: String)] {
    guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out: [(CGWindowID, CGRect, String)] = []
    for entry in list {
        guard (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (entry[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let number = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let bounds = entry[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds),
              frame.width > 50, frame.height > 50
        else { continue }
        out.append((number, frame, entry[kCGWindowName as String] as? String ?? ""))
    }
    return out
}

/// Private but long-lived (window managers have relied on it for years): builds
/// an accessibility element from a raw token. `kAXWindowsAttribute` only lists
/// windows on the active Space, so a simulator left on another desktop, or
/// behind the lock screen, would otherwise look like it has no windows.
typealias AXCreateWithTokenFn = @convention(c) (CFData) -> Unmanaged<AXUIElement>?
let axCreateWithToken: AXCreateWithTokenFn? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementCreateWithRemoteToken") else { return nil }
    return unsafeBitCast(symbol, to: AXCreateWithTokenFn.self)
}()

/// Finds the accessibility elements of `wanted` windows by probing element ids.
func windowElementsByToken(pid: pid_t, wanted: Set<CGWindowID>) -> [CGWindowID: AXUIElement] {
    guard let axCreateWithToken, let axGetWindow, !wanted.isEmpty else { return [:] }
    var found: [CGWindowID: AXUIElement] = [:]
    let deadline = Date().addingTimeInterval(1.5)
    for elementId in UInt64(0)..<50_000 {
        if found.count == wanted.count || (elementId % 256 == 0 && Date() > deadline) { break }
        var token = Data()
        withUnsafeBytes(of: pid) { token.append(contentsOf: $0) }
        withUnsafeBytes(of: Int32(0)) { token.append(contentsOf: $0) }
        withUnsafeBytes(of: Int32(0x636f_636f)) { token.append(contentsOf: $0) }
        withUnsafeBytes(of: elementId) { token.append(contentsOf: $0) }
        guard let element = axCreateWithToken(token as CFData)?.takeRetainedValue() else { continue }
        AXUIElementSetMessagingTimeout(element, 0.25)
        guard axString(element, kAXRoleAttribute) == "AXWindow" else { continue }
        var id: CGWindowID = 0
        guard axGetWindow(element, &id) == .success, wanted.contains(id), found[id] == nil else { continue }
        AXUIElementSetMessagingTimeout(element, 3)
        found[id] = element
    }
    return found
}

/// The simulator's real windows: the device window and any dialogs.
///
/// The window server's list is the source of truth, because it is the only one
/// that survives every situation. Accessibility adds detail (role, minimised,
/// the element needed to inspect a dialog) when it can, and it cannot always:
/// `kAXWindows` omits windows on other Spaces, and while the screen is locked
/// macOS replaces every window element with the application element.
func simulatorWindows(_ app: NSRunningApplication) -> [WindowInfo] {
    let pid = app.processIdentifier
    let fromServer = cgWindows(pid: pid)
    var elements: [CGWindowID: AXUIElement] = [:]
    if AXIsProcessTrusted() {
        let axApp = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(axApp, 3)
        for element in axValue(axApp, kAXWindowsAttribute) as? [AXUIElement] ?? [] {
            guard axString(element, kAXRoleAttribute) == "AXWindow" else { continue } // redacted while locked
            var id: CGWindowID = 0
            if let axGetWindow, axGetWindow(element, &id) == .success, id != 0 {
                elements[id] = element
            } else if let frame = axFrame(element), let match = fromServer.first(where: {
                abs($0.frame.minX - frame.minX) < 2 && abs($0.frame.minY - frame.minY) < 2
                    && abs($0.frame.width - frame.width) < 2 && abs($0.frame.height - frame.height) < 2 }) {
                elements[match.id] = element
            }
        }
        // Titled windows Accessibility did not list are on another Space.
        let missing = Set(fromServer.filter { elements[$0.id] == nil && !$0.title.isEmpty }.map(\.id))
        if !screenLocked() {
            for (id, element) in windowElementsByToken(pid: pid, wanted: missing) { elements[id] = element }
        }
    }

    var out: [WindowInfo] = []
    for window in fromServer {
        if let element = elements[window.id] {
            out.append(WindowInfo(
                id: window.id,
                title: axString(element, kAXTitleAttribute) ?? window.title,
                frame: axFrame(element) ?? window.frame,
                role: axString(element, kAXRoleAttribute) ?? "AXWindow",
                subrole: axString(element, kAXSubroleAttribute) ?? "",
                minimized: axBool(element, kAXMinimizedAttribute) ?? false,
                modal: axBool(element, kAXModalAttribute) ?? false,
                element: element))
        } else if !window.title.isEmpty {
            // Known only to the window server. AppKit's own helper windows are
            // untitled, so a title means a real window; the device window's
            // title always starts the same way.
            out.append(WindowInfo(
                id: window.id, title: window.title, frame: window.frame, role: "AXWindow",
                subrole: window.title.hasPrefix("CIQ Simulator") ? "AXStandardWindow" : "AXDialog",
                minimized: false, modal: false, element: nil))
        }
    }
    if out.isEmpty, !CGPreflightScreenCaptureAccess() {
        // No Accessibility detail and no titles (they need Screen Recording):
        // the largest plausible window is the device window.
        let pool = fromServer.filter { $0.frame.height > 100 && $0.frame.width < 3000 }
        if let device = pool.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) {
            out.append(WindowInfo(id: device.id, title: device.title, frame: device.frame, role: "AXWindow",
                                  subrole: "AXStandardWindow", minimized: false, modal: false, element: nil))
        }
    }
    // Dialogs first, newest (highest id) first: the order they must be answered in.
    return out.sorted { ($0.isDeviceWindow ? 0 : 1, $0.id) > ($1.isDeviceWindow ? 0 : 1, $1.id) }
}

func deviceWindow(_ app: NSRunningApplication, _ args: Args) throws -> WindowInfo {
    let windows = simulatorWindows(app)
    if let wanted = args.int("windowId") {
        guard let window = windows.first(where: { Int($0.id) == wanted }) else {
            throw Failure(code: "window_not_found", message: "The simulator has no window with id \(wanted); it may have closed.",
                          extra: ["windows": windows.map(\.json)])
        }
        return window
    }
    guard let window = windows.first(where: { $0.isDeviceWindow }) else {
        throw Failure(code: "window_not_found", message: "The simulator has no device window yet.")
    }
    return window
}

func screenLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
}

/// Wakes the display if it is asleep; window contents cannot be captured while
/// it sleeps. The session stays locked. Returns whether a wake was needed.
@discardableResult
func wakeDisplayIfAsleep() -> Bool {
    guard CGDisplayIsAsleep(CGMainDisplayID()) != 0 else { return false }
    var assertion: IOPMAssertionID = 0
    IOPMAssertionDeclareUserActivity("owl-connectiq-simulator-mcp" as CFString, kIOPMUserActiveLocal, &assertion)
    let deadline = Date().addingTimeInterval(6)
    while CGDisplayIsAsleep(CGMainDisplayID()) != 0, Date() < deadline { usleep(100_000) }
    usleep(700_000) // the first frames after a wake are not capturable yet
    if assertion != 0 { IOPMAssertionRelease(assertion) }
    return true
}

// MARK: - status

func commandStatus(_ args: Args) throws -> [String: Any] {
    var out: [String: Any] = [
        "helperVersion": helperVersion,
        "accessibility": AXIsProcessTrusted(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "screenLocked": screenLocked(),
        "displayAsleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0,
        "backgroundClicks": setWindowLocation != nil,
    ]
    if let app = try? simulatorApp(args) {
        let windows = simulatorWindows(app)
        out["simulator"] = [
            "pid": Int(app.processIdentifier),
            "hidden": app.isHidden,
            "active": app.isActive,
            "path": app.bundleURL?.path ?? "",
            "windows": windows.map(\.json),
        ] as [String: Any]
    } else {
        out["simulator"] = NSNull()
    }
    return out
}

// MARK: - capture

func captureWithScreenCaptureKit(windowId: CGWindowID) async throws -> CGImage {
    guard #available(macOS 14.0, *) else {
        throw Failure(code: "capture_failed", message: "ScreenCaptureKit screenshots need macOS 14 or later.")
    }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
        throw Failure(code: "capture_failed", message: "ScreenCaptureKit does not list window \(windowId).")
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    let scale = Double(filter.pointPixelScale)
    configuration.width = Int((Double(window.frame.width) * scale).rounded())
    configuration.height = Int((Double(window.frame.height) * scale).rounded())
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    configuration.scalesToFit = false
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
}

func captureWithScreencapture(windowId: CGWindowID) throws -> CGImage {
    let path = NSTemporaryDirectory() + "ciq-sim-helper-\(getpid())-\(windowId).png"
    defer { try? FileManager.default.removeItem(atPath: path) }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-o", "-l", String(windowId), path]
    let errors = Pipe()
    process.standardError = errors
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0,
          // Read into memory first: image decoding is lazy and the file is about to go.
          let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        let detail = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        throw Failure(code: "capture_failed", message: "screencapture failed: \(detail.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
    return image
}

func captureWindow(windowId: CGWindowID, method: String) async throws -> (CGImage, String) {
    wakeDisplayIfAsleep()
    var problems: [String] = []
    let order = method == "screencapture" ? ["screencapture"] : method == "screencapturekit" ? ["screencapturekit"]
        : ["screencapturekit", "screencapture"]
    for candidate in order {
        do {
            let image = candidate == "screencapturekit"
                ? try await captureWithScreenCaptureKit(windowId: windowId)
                : try captureWithScreencapture(windowId: windowId)
            return (image, candidate)
        } catch let failure as Failure {
            problems.append("\(candidate): \(failure.message)")
        } catch {
            problems.append("\(candidate): \(error.localizedDescription)")
        }
    }
    if !CGPreflightScreenCaptureAccess() {
        throw Failure(
            code: "screen_recording_denied",
            message: "Screen Recording permission is missing. Grant it to the app that launches this MCP server "
                + "(your terminal, IDE or Claude) in System Settings > Privacy & Security > Screen & System Audio Recording, "
                + "then restart that app. (" + problems.joined(separator: "; ") + ")")
    }
    throw Failure(code: "capture_failed", message: problems.joined(separator: "; "))
}

/// True when every sampled pixel is identical: what a capture of a window that
/// has never drawn (or was captured without permission) looks like.
func isBlank(_ image: CGImage) -> Bool {
    let side = 32
    var pixels = [UInt8](repeating: 0, count: side * side * 4)
    guard let context = CGContext(data: &pixels, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return false }
    context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
    for index in stride(from: 4, to: pixels.count, by: 4)
    where pixels[index] != pixels[0] || pixels[index + 1] != pixels[1] || pixels[index + 2] != pixels[2] {
        return false
    }
    return true
}

func commandCapture(_ args: Args) async throws -> [String: Any] {
    let out = try args.need("out", args.string("out"))
    let app = try simulatorApp(args)
    let window = try deviceWindow(app, args)
    if window.minimized {
        throw Failure(code: "window_minimized", message: "The simulator window is minimised; it cannot be captured until it is restored.")
    }
    let (image, method) = try await captureWindow(windowId: window.id, method: args.string("method") ?? "auto")
    let scale = Double(image.width) / max(1, Double(window.frame.width))

    // Crop rectangle in window points (top-left origin, title bar included).
    var crop = CGRect(x: 0, y: 0, width: Double(image.width), height: Double(image.height))
    if let rect = args.dict("crop") {
        crop = CGRect(
            x: (try rect.need("x", rect.double("x")) * scale).rounded(),
            y: (try rect.need("y", rect.double("y")) * scale).rounded(),
            width: (try rect.need("width", rect.double("width")) * scale).rounded(),
            height: (try rect.need("height", rect.double("height")) * scale).rounded())
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        guard bounds.contains(crop), crop.width >= 1, crop.height >= 1 else {
            throw Failure(
                code: "crop_out_of_bounds",
                message: "The requested area \(crop) is outside the captured window (\(image.width)x\(image.height) px). "
                    + "The simulator window may have been resized smaller than the device image.")
        }
    }
    guard let cropped = image.cropping(to: crop) else {
        throw Failure(code: "capture_failed", message: "Could not crop the captured image.")
    }
    let width = args.int("outWidth") ?? Int(crop.width)
    let height = args.int("outHeight") ?? Int(crop.height)
    guard width > 0, height > 0, width <= 8192, height <= 8192,
          let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw Failure(code: "bad_arguments", message: "invalid output size \(width)x\(height)") }
    let target = CGRect(x: 0, y: 0, width: width, height: height)
    context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    context.fill(target)
    if args.string("mask") == "round" { context.addEllipse(in: target); context.clip() }
    // Integer ratios (1:1, 2:1 Retina) must not blur; anything else is averaged.
    let ratio = Double(cropped.width) / Double(width)
    context.interpolationQuality = ratio == ratio.rounded() && ratio <= 1 ? .none : .high
    context.draw(cropped, in: target)
    guard let result = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, "public.png" as CFString, 1, nil)
    else { throw Failure(code: "capture_failed", message: "Could not create \(out).") }
    CGImageDestinationAddImage(destination, result, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw Failure(code: "capture_failed", message: "Could not write \(out).")
    }
    var report: [String: Any] = [
        "path": out, "width": width, "height": height, "method": method, "scale": scale,
        "blank": isBlank(result), "screenLocked": screenLocked(), "window": window.json,
    ]
    if args.bool("text") == true {
        // Positions are reported in crop points, i.e. device pixels for a screen
        // capture, whatever size the picture itself was scaled to.
        report["texts"] = recogniseText(result, size: CGSize(width: crop.width / scale, height: crop.height / scale))
    }
    return report
}

// MARK: - text recognition

/// Reads the text in an image with the Vision framework (on-device, offline).
/// A watch screen is a canvas with no element tree, so recognised text with its
/// position is the closest thing to a DOM: it lets an agent say "tap Trains"
/// and "wait until Departures appears" instead of guessing pixels and sleeping.
///
/// Boxes are returned in the coordinates of `size` (top-left origin).
func recogniseText(_ image: CGImage, size: CGSize) -> [[String: Any]] {
    // Small UI text recognises far better enlarged.
    let factor = max(1, min(4, Int((1200 / Double(max(image.width, 1))).rounded(.up))))
    var input = image
    if factor > 1,
       let context = CGContext(data: nil, width: image.width * factor, height: image.height * factor, bitsPerComponent: 8,
                               bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                               bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width * factor, height: image.height * factor))
        input = context.makeImage() ?? image
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false // route numbers and stop codes are not words
    request.minimumTextHeight = 0.015
    do { try VNImageRequestHandler(cgImage: input, options: [:]).perform([request]) } catch { return [] }
    var out: [[String: Any]] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox // normalised, bottom-left origin
        out.append([
            "text": candidate.string,
            "confidence": (Double(candidate.confidence) * 100).rounded() / 100,
            "x": Double((box.minX * size.width).rounded()), "y": Double(((1 - box.maxY) * size.height).rounded()),
            "width": Double((box.width * size.width).rounded()), "height": Double((box.height * size.height).rounded()),
        ])
    }
    // Reading order: top to bottom, then left to right.
    return out.sorted {
        let (ay, by) = ($0["y"] as! Double, $1["y"] as! Double)
        return abs(ay - by) > 6 ? ay < by : ($0["x"] as! Double) < ($1["x"] as! Double)
    }
}

// MARK: - locate

func rgbaBitmap(_ image: CGImage, width: Int, height: Int) -> [UInt8]? {
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return false }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    return drawn ? pixels : nil
}

/// Finds where the simulator drew the device picture inside its window.
///
/// The simulator paints the device PNG unscaled, flush left, directly under the
/// title bar. The title bar's height is the one unknown (it depends on the macOS
/// release and on the SDK the simulator was linked against), so measure it:
/// slide the PNG's opaque pixels down the capture and keep the best match.
func commandLocate(_ args: Args) async throws -> [String: Any] {
    let imagePath = try args.need("image", args.string("image"))
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: imagePath) as CFURL, nil),
          let reference = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw Failure(code: "bad_arguments", message: "Could not read the device image \(imagePath).") }
    let app = try simulatorApp(args)
    let window = try deviceWindow(app, args)
    if window.minimized { throw Failure(code: "window_minimized", message: "The simulator window is minimised.") }
    let (capture, method) = try await captureWindow(windowId: window.id, method: args.string("method") ?? "auto")

    // Work in window points, so a Retina capture is reduced first.
    let width = Int(window.frame.width.rounded()), height = Int(window.frame.height.rounded())
    guard let shot = rgbaBitmap(capture, width: width, height: height),
          let picture = rgbaBitmap(reference, width: reference.width, height: reference.height)
    else { throw Failure(code: "capture_failed", message: "Could not read the captured pixels.") }

    var exclude = CGRect.null
    if let rect = args.dict("exclude") {
        exclude = CGRect(x: rect.double("x") ?? 0, y: rect.double("y") ?? 0, width: rect.double("width") ?? 0, height: rect.double("height") ?? 0)
            .insetBy(dx: -4, dy: -4)
    }
    var best = (offset: -1, score: Double.infinity, samples: 0)
    let step = 2
    var scores: [Double] = []
    for offset in 0...96 {
        var total = 0.0
        var samples = 0
        var y = 0
        while y < reference.height {
            let row = y + offset
            if row >= height { break }
            var x = 0
            while x < min(reference.width, width) {
                let p = (y * reference.width + x) * 4
                if picture[p + 3] == 255, !exclude.contains(CGPoint(x: x, y: y)) {
                    let q = (row * width + x) * 4
                    total += abs(Double(picture[p]) - Double(shot[q])) + abs(Double(picture[p + 1]) - Double(shot[q + 1]))
                        + abs(Double(picture[p + 2]) - Double(shot[q + 2]))
                    samples += 1
                }
                x += step
            }
            y += step
        }
        guard samples > 500 else { scores.append(.infinity); continue }
        let score = total / Double(samples * 3)
        scores.append(score)
        if score < best.score { best = (offset, score, samples) }
    }
    // A real match is close in absolute terms and sits at the bottom of a clear
    // dip: a few points either side must be distinctly worse. (Scores never reach
    // zero because the capture is colour-managed and the PNG is not.)
    func score(at offset: Int) -> Double { offset >= 0 && offset < scores.count ? scores[offset] : .infinity }
    let found = best.offset >= 0 && best.score < 14
        && score(at: best.offset - 4) > best.score * 1.5 && score(at: best.offset + 4) > best.score * 1.5
    return [
        "found": found, "offsetX": 0, "offsetY": best.offset, "score": best.score.isFinite ? best.score : -1,
        "samples": best.samples, "method": method,
        "imageWidth": reference.width, "imageHeight": reference.height, "window": window.json,
    ]
}

// MARK: - mouse

/// Private CoreGraphics call that sets an event's window-relative location.
/// Without it AppKit hit-tests an event posted to a pid at the window's origin.
typealias SetWindowLocationFn = @convention(c) (CGEvent, CGPoint) -> Void
let setWindowLocation: SetWindowLocationFn? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation") else { return nil }
    return unsafeBitCast(symbol, to: SetWindowLocationFn.self)
}()

/// Undocumented field: the window number AppKit reads into `NSEvent.windowNumber`.
/// A mouse-down posted to a pid without it has no window and is dropped.
let eventWindowNumberField = CGEventField(rawValue: 51)!

func commandMouse(_ args: Args) throws -> [String: Any] {
    try requireAccessibility()
    guard let setWindowLocation else {
        throw Failure(code: "unsupported_os", message: "This macOS release has no CGEventSetWindowLocation; background input is unavailable.")
    }
    let steps = try args.need("steps", args.list("steps") as? [[String: Any]])
    let app = try simulatorApp(args)
    let window = try deviceWindow(app, args)
    if window.minimized { throw Failure(code: "window_minimized", message: "The simulator window is minimised.") }
    wakeDisplayIfAsleep()
    let pid = app.processIdentifier
    let source = CGEventSource(stateID: .privateState)
    var isDown = false
    var last = CGPoint.zero
    var posted = 0

    func post(_ type: CGEventType, _ local: CGPoint) throws {
        let global = CGPoint(x: window.frame.minX + local.x, y: window.frame.minY + local.y)
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: global, mouseButton: .left) else {
            throw Failure(code: "input_failed", message: "Could not create a mouse event.")
        }
        if type != .mouseMoved {
            event.setIntegerValueField(.mouseEventClickState, value: 1)
            event.setDoubleValueField(.mouseEventPressure, value: type == .leftMouseUp ? 0 : 1)
        }
        event.setIntegerValueField(eventWindowNumberField, value: Int64(window.id))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.id))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.id))
        setWindowLocation(event, local)
        event.postToPid(pid)
        posted += 1
        last = local
    }

    func point(_ step: [String: Any]) throws -> CGPoint {
        guard let x = (step["x"] as? NSNumber)?.doubleValue, let y = (step["y"] as? NSNumber)?.doubleValue else {
            throw Failure(code: "bad_arguments", message: "mouse step needs numeric x and y")
        }
        guard x >= 0, y >= 0, x <= window.frame.width, y <= window.frame.height else {
            throw Failure(code: "point_outside_window", message: "(\(x), \(y)) is outside the \(Int(window.frame.width))x\(Int(window.frame.height)) simulator window.")
        }
        return CGPoint(x: x, y: y)
    }

    // The simulator decides whether a press became a *hold* by asking where the
    // real pointer is when its hold timer fires, not by looking at the events it
    // was sent. So for holds the pointer is parked on the target for the length
    // of the gesture, detached from the physical mouse so a nudge cannot move it,
    // and put back afterwards. Taps, clicks and swipes never need this.
    var parkedFrom: CGPoint?
    func unpark() {
        guard let origin = parkedFrom else { return }
        CGWarpMouseCursorPosition(origin)
        CGAssociateMouseAndMouseCursorPosition(1)
        parkedFrom = nil
    }
    if args.bool("parkPointer") == true,
       let first = steps.first(where: { $0["op"] as? String == "down" }),
       let x = (first["x"] as? NSNumber)?.doubleValue, let y = (first["y"] as? NSNumber)?.doubleValue {
        parkedFrom = CGEvent(source: nil)?.location
        CGAssociateMouseAndMouseCursorPosition(0)
        CGWarpMouseCursorPosition(CGPoint(x: window.frame.minX + x, y: window.frame.minY + y))
    }
    defer { unpark() }

    do {
        for step in steps {
            switch step["op"] as? String {
            case "move":
                try post(isDown ? .leftMouseDragged : .mouseMoved, try point(step))
            case "down":
                let target = try point(step)
                try post(.mouseMoved, target)
                usleep(20_000)
                try post(.leftMouseDown, target)
                isDown = true
            case "up":
                try post(.leftMouseUp, step["x"] == nil ? last : try point(step))
                isDown = false
            case "wait":
                let ms = (step["ms"] as? NSNumber)?.doubleValue ?? 0
                guard ms >= 0, ms <= 60_000 else { throw Failure(code: "bad_arguments", message: "wait must be 0...60000 ms") }
                usleep(UInt32(ms * 1000))
            default:
                throw Failure(code: "bad_arguments", message: "unknown mouse op \(String(describing: step["op"]))")
            }
        }
    } catch {
        // Never leave the simulator believing a button is held down.
        if isDown { try? post(.leftMouseUp, last) }
        throw error
    }
    if isDown { try post(.leftMouseUp, last) }
    usleep(30_000) // let the events drain before this process exits
    return ["events": posted, "window": window.json]
}

// MARK: - key

let keyCodes: [String: CGKeyCode] = [
    "enter": 36, "return": 36, "escape": 53, "esc": 53, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "forwarddelete": 117, "up": 126, "down": 125, "left": 123, "right": 124, "home": 115, "end": 119,
    "pageup": 116, "pagedown": 121, "a": 0,
]

/// Types into one window. Key events posted to a pid normally go to the app's
/// key window, and a background app has none; addressing the event to a window
/// number makes AppKit deliver it to that window's first responder anyway.
func commandKey(_ args: Args) throws -> [String: Any] {
    try requireAccessibility()
    let steps = try args.need("steps", args.list("steps") as? [[String: Any]])
    let app = try simulatorApp(args)
    _ = try args.need("windowId", args.int("windowId"))
    let window = try deviceWindow(app, args)
    let pid = app.processIdentifier
    let source = CGEventSource(stateID: .privateState)
    var posted = 0

    func post(_ event: CGEvent?) throws {
        guard let event else { throw Failure(code: "input_failed", message: "Could not create a keyboard event.") }
        event.setIntegerValueField(eventWindowNumberField, value: Int64(window.id))
        event.postToPid(pid)
        posted += 1
        usleep(12_000)
    }

    for step in steps {
        if let text = step["text"] as? String {
            guard text.utf16.count <= 4000 else { throw Failure(code: "bad_arguments", message: "text is too long") }
            for unit in text.utf16 {
                for down in [true, false] {
                    let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                    var character = [unit]
                    event?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
                    event?.flags = []
                    try post(event)
                }
            }
        } else if let name = step["key"] as? String {
            guard let code = keyCodes[name.lowercased()] else {
                throw Failure(code: "bad_arguments", message: "unknown key '\(name)'", extra: ["available": keyCodes.keys.sorted()])
            }
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
                event?.flags = step["command"] as? Bool == true ? .maskCommand : []
                try post(event)
            }
        } else if let ms = (step["wait"] as? NSNumber)?.doubleValue, ms >= 0, ms <= 10_000 {
            usleep(UInt32(ms * 1000))
        } else {
            throw Failure(code: "bad_arguments", message: "a key step needs text, key or wait")
        }
    }
    usleep(250_000)
    return ["events": posted, "windows": simulatorWindows(app).map(\.json)]
}

// MARK: - menu

func menuBar(_ app: NSRunningApplication) throws -> AXUIElement {
    try requireAccessibility()
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(axApp, 3)
    guard let bar = axValue(axApp, kAXMenuBarAttribute) else {
        throw Failure(code: "menu_unavailable", message: "The simulator's menu bar is not available (is it still starting?).")
    }
    return bar as! AXUIElement
}

/// The entries under a menu bar item or menu item (skipping the AXMenu wrapper).
func menuEntries(_ element: AXUIElement) -> [AXUIElement] {
    let children = axChildren(element)
    if children.count == 1, axString(children[0], kAXRoleAttribute) == "AXMenu" { return axChildren(children[0]) }
    return children
}

func menuItemJSON(_ element: AXUIElement, depth: Int) -> [String: Any]? {
    let title = axString(element, kAXTitleAttribute) ?? ""
    if title.isEmpty { return nil } // separator
    var out: [String: Any] = ["title": title, "enabled": axBool(element, kAXEnabledAttribute) ?? true]
    if let mark = axString(element, "AXMenuItemMarkChar"), !mark.isEmpty { out["checked"] = true }
    if depth < 6 {
        let children = menuEntries(element).compactMap { menuItemJSON($0, depth: depth + 1) }
        if !children.isEmpty { out["items"] = children }
    }
    return out
}

func topLevelMenus(_ bar: AXUIElement) -> [AXUIElement] {
    // Index 0 is the Apple menu: system-wide items (Lock Screen, Shut Down) that
    // have nothing to do with the simulator and must not be reachable from here.
    Array(axChildren(bar).dropFirst())
}

func commandMenuList(_ args: Args) throws -> [String: Any] {
    let bar = try menuBar(try simulatorApp(args))
    return ["menus": topLevelMenus(bar).compactMap { menuItemJSON($0, depth: 0) }]
}

func normaliseTitle(_ title: String) -> String {
    title.replacingOccurrences(of: "…", with: "...").trimmingCharacters(in: .whitespaces).lowercased()
}

func commandMenuPress(_ args: Args) throws -> [String: Any] {
    let path = try args.need("path", args.list("path") as? [String])
    guard !path.isEmpty else { throw Failure(code: "bad_arguments", message: "path must not be empty") }
    let app = try simulatorApp(args)
    let bar = try menuBar(app)
    var pool = topLevelMenus(bar)
    var current: AXUIElement?
    for (index, name) in path.enumerated() {
        let titles = pool.map { axString($0, kAXTitleAttribute) ?? "" }
        guard let match = titles.firstIndex(of: name) ?? titles.firstIndex(where: { normaliseTitle($0) == normaliseTitle(name) }) else {
            throw Failure(
                code: "menu_item_not_found",
                message: "No menu item '\(name)' under '\(path.prefix(index).joined(separator: " > "))'.",
                extra: ["available": titles.filter { !$0.isEmpty }])
        }
        current = pool[match]
        pool = menuEntries(pool[match])
    }
    guard let item = current else { throw Failure(code: "bad_arguments", message: "path must not be empty") }
    if axBool(item, kAXEnabledAttribute) == false {
        throw Failure(code: "menu_item_disabled", message: "'\(path.joined(separator: " > "))' is disabled in the simulator's current state.")
    }
    if !pool.isEmpty {
        throw Failure(code: "menu_item_is_submenu", message: "'\(path.joined(separator: " > "))' is a submenu; choose one of its items.",
                      extra: ["available": pool.compactMap { axString($0, kAXTitleAttribute) }.filter { !$0.isEmpty }])
    }
    let status = AXUIElementPerformAction(item, kAXPressAction as CFString)
    // A menu item that opens a modal dialog does not return until the dialog
    // closes, so the press times out even though it worked.
    guard status == .success || status == .cannotComplete else {
        throw Failure(code: "menu_press_failed", message: "Pressing the menu item failed: \(axErrorName(status)).")
    }
    usleep(250_000)
    var out: [String: Any] = ["pressed": path, "windows": simulatorWindows(app).map(\.json)]
    if let mark = axString(item, "AXMenuItemMarkChar") { out["checked"] = !mark.isEmpty }
    return out
}

// MARK: - ui (dialogs)

let chromeSubroles: Set<String> = ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"]

func describeValue(_ value: AnyObject?) -> Any? {
    guard let value else { return nil }
    if let string = value as? String { return string.count > 2000 ? String(string.prefix(2000)) + "…" : string }
    if let number = value as? NSNumber { return number }
    return nil
}

func collectElements(_ element: AXUIElement, path: String, origin: CGPoint, depth: Int, into out: inout [[String: Any]]) {
    for (index, child) in axChildren(element).enumerated() {
        if out.count >= 500 { return }
        let childPath = path.isEmpty ? String(index) : "\(path).\(index)"
        let role = axString(child, kAXRoleAttribute) ?? ""
        let subrole = axString(child, kAXSubroleAttribute) ?? ""
        if chromeSubroles.contains(subrole) { continue }
        var entry: [String: Any] = ["id": childPath, "role": role]
        if !subrole.isEmpty { entry["subrole"] = subrole }
        if let title = axString(child, kAXTitleAttribute), !title.isEmpty { entry["title"] = title }
        if let description = axString(child, kAXDescriptionAttribute), !description.isEmpty { entry["description"] = description }
        if let value = describeValue(axValue(child, kAXValueAttribute)) { entry["value"] = value }
        if axBool(child, kAXEnabledAttribute) == false { entry["enabled"] = false }
        if axBool(child, kAXFocusedAttribute) == true { entry["focused"] = true }
        if axBool(child, kAXSelectedAttribute) == true { entry["selected"] = true }
        var settable: DarwinBoolean = false
        if AXUIElementIsAttributeSettable(child, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue {
            entry["settable"] = true
        }
        let actions = axActions(child)
        if !actions.isEmpty { entry["actions"] = actions }
        if let frame = axFrame(child) {
            entry["frame"] = ["x": frame.minX - origin.x, "y": frame.minY - origin.y, "width": frame.width, "height": frame.height]
        }
        out.append(entry)
        if depth < 12 { collectElements(child, path: childPath, origin: origin, depth: depth + 1, into: &out) }
    }
}

func commandUIDump(_ args: Args) throws -> [String: Any] {
    try requireAccessibility()
    let app = try simulatorApp(args)
    var windows: [[String: Any]] = []
    for window in simulatorWindows(app) {
        var entry = window.json
        guard let element = window.element else {
            entry["elements"] = []
            windows.append(entry)
            continue
        }
        if window.isDeviceWindow && args.bool("includeDeviceWindow") != true {
            // The device window is one opaque canvas: nothing in it is addressable.
            entry["elements"] = []
        } else {
            var elements: [[String: Any]] = []
            collectElements(element, path: "", origin: window.frame.origin, depth: 0, into: &elements)
            entry["elements"] = elements
        }
        windows.append(entry)
    }
    return ["windows": windows]
}

func commandUIAction(_ args: Args) throws -> [String: Any] {
    try requireAccessibility()
    let app = try simulatorApp(args)
    let windowId = try args.need("windowId", args.int("windowId"))
    let elementId = try args.need("element", args.string("element"))
    let windows = simulatorWindows(app)
    guard let window = windows.first(where: { Int($0.id) == windowId }) else {
        throw Failure(code: "window_not_found", message: "The simulator has no window with id \(windowId); it may have closed.",
                      extra: ["windows": windows.map(\.json)])
    }
    guard var element = window.element else {
        throw Failure(code: "dialog_not_inspectable",
                      message: "The controls of this window are hidden from Accessibility\(screenLocked() ? " while the screen is locked" : "").")
    }
    for part in elementId.split(separator: ".") {
        let children = axChildren(element)
        guard let index = Int(part), index >= 0, index < children.count else {
            throw Failure(code: "element_not_found", message: "No element '\(elementId)' in window \(windowId); inspect the window again.")
        }
        element = children[index]
    }
    let role = axString(element, kAXRoleAttribute) ?? ""
    if let expected = args.string("expectRole"), expected != role {
        throw Failure(code: "element_changed", message: "Element '\(elementId)' is now a \(role), not a \(expected); inspect the window again.")
    }
    if axBool(element, kAXEnabledAttribute) == false {
        throw Failure(code: "element_disabled", message: "Element '\(elementId)' (\(role)) is disabled.")
    }
    var out: [String: Any] = ["element": elementId, "role": role]
    if let raw = args.raw["value"], !(raw is NSNull) {
        let value: AnyObject = (raw as? String).map { $0 as AnyObject } ?? (raw as AnyObject)
        let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value)
        guard status == .success else {
            throw Failure(code: "set_value_failed", message: "Could not set the value of '\(elementId)' (\(role)): \(axErrorName(status)).")
        }
        out["value"] = describeValue(axValue(element, kAXValueAttribute)) ?? NSNull()
    }
    if let action = args.string("action") {
        let available = axActions(element)
        guard available.contains(action) else {
            throw Failure(code: "action_unsupported", message: "Element '\(elementId)' (\(role)) does not support \(action).",
                          extra: ["available": available])
        }
        let status = AXUIElementPerformAction(element, action as CFString)
        guard status == .success || status == .cannotComplete else {
            throw Failure(code: "action_failed", message: "\(action) on '\(elementId)' failed: \(axErrorName(status)).")
        }
        out["action"] = action
    }
    usleep(250_000)
    out["windows"] = simulatorWindows(app).map(\.json)
    return out
}

// MARK: - window

func commandWindow(_ args: Args) throws -> [String: Any] {
    try requireAccessibility()
    let app = try simulatorApp(args)
    let action = try args.need("action", args.string("action"))
    if action == "unhide" {
        app.unhide()
        usleep(300_000)
        return ["windows": simulatorWindows(app).map(\.json)]
    }
    let window = try deviceWindow(app, args)
    guard let element = window.element else { throw Failure(code: "window_not_found", message: "The simulator window is not accessible.") }
    var status = AXError.success
    switch action {
    case "restore":
        if app.isHidden { app.unhide() }
        status = AXUIElementSetAttributeValue(element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    case "resize":
        var size = CGSize(width: try args.need("width", args.double("width")), height: try args.need("height", args.double("height")))
        status = AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
    case "move":
        var origin = CGPoint(x: try args.need("x", args.double("x")), y: try args.need("y", args.double("y")))
        status = AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &origin)!)
    default:
        throw Failure(code: "bad_arguments", message: "unknown window action '\(action)'")
    }
    guard status == .success else {
        throw Failure(code: "window_action_failed", message: "Window \(action) failed: \(axErrorName(status)).")
    }
    usleep(400_000)
    return ["windows": simulatorWindows(app).map(\.json)]
}

// MARK: - main

func dispatch(_ command: String, _ args: Args) async throws -> [String: Any] {
    switch command {
    case "version": return ["helperVersion": helperVersion]
    case "status": return try commandStatus(args)
    case "capture": return try await commandCapture(args)
    case "locate": return try await commandLocate(args)
    case "mouse": return try commandMouse(args)
    case "key": return try commandKey(args)
    case "menu-list": return try commandMenuList(args)
    case "menu-press": return try commandMenuPress(args)
    case "ui-dump": return try commandUIDump(args)
    case "ui-action": return try commandUIAction(args)
    case "window": return try commandWindow(args)
    default: throw Failure(code: "bad_arguments", message: "unknown command '\(command)'")
    }
}

func failureJSON(_ error: Error) -> [String: Any] {
    let failure = error as? Failure ?? Failure(code: "internal", message: error.localizedDescription)
    var body = failure.extra
    body["code"] = failure.code
    body["message"] = failure.message
    return ["ok": false, "error": body]
}

let outputLock = NSLock()

/// Reads requests until stdin closes. Each runs in its own task, so a slow one
/// (a long press, the first text recognition) does not hold up a status check;
/// callers that need ordering wait for each reply before sending the next.
func serve() {
    // Load the text recognition model now, off to the side.
    Task.detached(priority: .utility) {
        if let context = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
                                   space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
           let blank = context.makeImage() {
            _ = recogniseText(blank, size: CGSize(width: 64, height: 64))
        }
    }
    let reader = Thread {
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty else { continue }
            let request = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
            let id = request?["id"] ?? NSNull()
            Task.detached {
                var reply: [String: Any]
                if let command = request?["command"] as? String {
                    do {
                        reply = try await dispatch(command, Args(raw: request?["args"] as? [String: Any] ?? [:]))
                        reply["ok"] = true
                    } catch {
                        reply = failureJSON(error)
                    }
                } else {
                    reply = failureJSON(Failure(code: "bad_arguments", message: "each request line must be a JSON object with a command"))
                }
                reply["id"] = id
                outputLock.lock()
                writeJSON(reply)
                outputLock.unlock()
            }
        }
        exit(0) // stdin closed: the server that owned this helper is gone
    }
    reader.stackSize = 1 << 20
    reader.start()
}

func runOnce() async {
    let argv = CommandLine.arguments
    var raw: [String: Any] = [:]
    if argv.count >= 3 {
        guard let parsed = try? JSONSerialization.jsonObject(with: Data(argv[2].utf8)) as? [String: Any] else {
            finish(Failure(code: "bad_arguments", message: "the second argument must be a JSON object"))
        }
        raw = parsed
    }
    do {
        finish(try await dispatch(argv[1], Args(raw: raw)))
    } catch let failure as Failure {
        finish(failure)
    } catch {
        finish(Failure(code: "internal", message: error.localizedDescription))
    }
}

if CommandLine.arguments.count < 2 {
    finish(Failure(code: "bad_arguments", message: "usage: ciq-sim-helper serve | <status|capture|locate|mouse|key|menu-list|menu-press|ui-dump|ui-action|window|version> ['<json>']"))
} else if CommandLine.arguments[1] == "serve" {
    setvbuf(stdout, nil, _IONBF, 0)
    serve()
} else {
    Task { await runOnce() }
}
RunLoop.main.run()
