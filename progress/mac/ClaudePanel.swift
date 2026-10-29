// Learn and the games in native macOS windows: one small AppKit app that shows a page of
// the local server (web/server.mjs) in a WKWebView, with no browser tabs or address bar.
// The server builds it with swiftc the first time it is needed and caches it; see
// `nativeApp` in web/server.mjs. One process per window:
//
//   ClaudePanel --url <http://127.0.0.1:port/learn/#token=...> --id <learn|games-chess|...> --title <Learn>
//               [--terminal <TERM_PROGRAM>] [--iterm-session <ITERM_SESSION_ID>]
//
// A second launch with an id already open brings that window forward and exits. Given the
// terminal, the window sticks to the chat's terminal window as the panel does: it moves
// with it, floats above it while it is in front, and hides with it.
//
// It is also the floating progress panel (the macOS twin of widget/PhasesWidget.ps1):
//
//   ClaudePanel --panel <phases.json> --html <mac/panel.html> --root <plugin root>
//               [--terminal <TERM_PROGRAM>] [--iterm-session <ITERM_SESSION_ID>]
//
// A small always-on-top window that draws the state file (contract 1 in CLAUDE.md) and
// sits at the top-right of the chat's terminal window, following it as it moves. Like
// the WPF panel it prints one JSON line per event (ready, closed, alive), exits on its ✕,
// and exits two seconds after the state file goes.
//
// Every window wears the colour scheme in ~/.config/claude-panel/appearance.json (web/server.mjs
// serves the same file to the pages). Windows are never faded as a whole: they are clear, and
// each page's background carries its group's see-through (panel, learn, games), so text stays
// sharp. The panel's ◐ strip and ⌘[ / ⌘] in a Learn or game window write that file.
import AppKit
import WebKit

struct Options {
    var url: URL?
    /// The server's token arrives on stdin, never in argv (which other users can read).
    var tokenOnStdin = false
    var id = "learn"
    var title = "Learn"
    // Panel mode.
    var panel: String?
    var html: String?
    var root: String?
    var terminal = ""
    var itermSession = ""
}

func readOptions() -> Options {
    var options = Options()
    var args = CommandLine.arguments.dropFirst().makeIterator()
    while let arg = args.next() {
        switch arg {
        case "--url": options.url = args.next().flatMap { URL(string: $0) }
        case "--token-stdin": options.tokenOnStdin = true
        case "--id": options.id = args.next() ?? options.id
        case "--title": options.title = args.next() ?? options.title
        case "--panel": options.panel = args.next()
        case "--html": options.html = args.next()
        case "--root": options.root = args.next()
        case "--terminal": options.terminal = args.next() ?? ""
        case "--iterm-session": options.itermSession = args.next() ?? ""
        default: break
        }
    }
    return options
}

// --- The appearance every window shares -------------------------------------------------

/// How see-through each group of windows is when nothing is saved: today's look (shared/theme.js DEFAULT_OPACITY).
let defaultOpacity: [String: Double] = ["panel": 0.92, "learn": 0.96, "games": 0.95]
/// Below this a clear window's empty background no longer takes clicks (shared/theme.js MIN_OPACITY).
let minOpacity = 0.15

/// ~/.config/claude-panel/appearance.json, or CLAUDE_PANEL_APPEARANCE (as web/server.mjs reads it).
func appearanceURL() -> URL {
    if let path = ProcessInfo.processInfo.environment["CLAUDE_PANEL_APPEARANCE"], !path.isEmpty {
        return URL(fileURLWithPath: path)
    }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/claude-panel/appearance.json")
}

/// A JSON file's top-level object, or nil when it is missing or not an object. Data, never code.
func readJSONObject(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func readAppearance() -> [String: Any]? { readJSONObject(appearanceURL()) }

/// When a file last changed (time and size): read again only when this differs.
func fileStamp(_ url: URL) -> String {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { return "none" }
    let time = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
    let size = (attributes[.size] as? NSNumber)?.int64Value ?? -1
    return "\(time) \(size)"
}

func isHexColor(_ text: String) -> Bool {
    text.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) != nil
}

/// The fields every reader knows, field by field from `value`, else from `saved`: {v, preset,
/// colors {bg, accent, text}, opacity {panel, learn, games}}. Readers check them again
/// (theme.js parseAppearance, Theme.ps1 Read-Appearance); a field left out is today's look.
func cleanAppearance(_ value: [String: Any], over saved: [String: Any]?) -> [String: Any] {
    var out: [String: Any] = ["v": 1]
    let presetName = (value["preset"] as? String) ?? (saved?["preset"] as? String) ?? "ember"
    let preset = String(presetName.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }.prefix(40))
    out["preset"] = preset.isEmpty ? "ember" : preset
    let givenColors = value["colors"] as? [String: Any]
    let savedColors = saved?["colors"] as? [String: Any]
    var colors: [String: String] = [:]
    for key in ["bg", "accent", "text"] {
        let candidates = [givenColors?[key] as? String, savedColors?[key] as? String].compactMap { $0 }
        if let hex = candidates.first(where: isHexColor) { colors[key] = hex.uppercased() }
    }
    if !colors.isEmpty { out["colors"] = colors }
    let givenOpacity = value["opacity"] as? [String: Any]
    let savedOpacity = saved?["opacity"] as? [String: Any]
    var opacity: [String: Double] = [:]
    for key in ["panel", "learn", "games"] {
        let number = (givenOpacity?[key] as? NSNumber) ?? (savedOpacity?[key] as? NSNumber)
        if let number, number.doubleValue.isFinite {
            opacity[key] = (min(max(number.doubleValue, minOpacity), 1) * 100).rounded() / 100
        }
    }
    if !opacity.isEmpty { out["opacity"] = opacity }
    return out
}

/// Written whole and atomically (a temporary file, then a rename), as UTF-8 JSON with no BOM.
@discardableResult
func writeAppearance(_ value: [String: Any]) -> Bool {
    let url = appearanceURL()
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else { return false }
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    return (try? data.write(to: url, options: .atomic)) != nil
}

/// One window per id: a pid file in ~/.cache/claude-panel/windows/<id>.pid.
func pidFile(_ id: String) -> URL {
    let safe = id.filter { $0.isLetter || $0.isNumber || $0 == "-" }
    let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache/claude-panel/windows")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("\(safe).pid")
}

/// The window already showing this id, if its process is alive. Its file says `<pid> <port>`:
/// one left from a server that has since restarted (another port) is closed, not reused.
func runningWindow(_ id: String, port: Int?) -> NSRunningApplication? {
    guard let text = try? String(contentsOf: pidFile(id), encoding: .utf8) else { return nil }
    let parts = text.split(separator: " ").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
    guard let first = parts.first, let pid = pid_t(first),
          pid != getpid(),
          let app = NSRunningApplication(processIdentifier: pid),
          !app.isTerminated else { return nil }
    if parts.count > 1, let port, Int(parts[1]) != port {
        app.terminate()
        return nil
    }
    return app
}

/// The window id of one of the server's pages, from its path (as web/server.mjs `windowId` names
/// them): /learn/ is 'learn', /games/ 'games', /games/2048/ 'games-2048'. Nil for any other path.
func pageId(_ path: String) -> String? {
    let parts = path.split(separator: "/").map { String($0) }
    guard let first = parts.first else { return nil }
    if first == "learn" { return "learn" }
    guard first == "games" else { return nil }
    if parts.count > 1, parts[1].range(of: "^[a-z0-9]+$", options: .regularExpression) != nil { return "games-\(parts[1])" }
    return "games"
}

/// A Learn or game window that can float over a full-screen terminal: a panel that takes the
/// keyboard without bringing this app forward (so the terminal's Space stays). The menu bar
/// isn't this app's then, so its shortcuts are handled here.
final class FloatingWindow: NSPanel {
    var onOpacity: ((CGFloat) -> Void)?
    var onReload: (() -> Void)?
    var onToggleFloat: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown, event.modifierFlags.contains(.command) else { return super.performKeyEquivalent(with: event) }
        let shift = event.modifierFlags.contains(.shift)
        let action: Selector?
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "c": action = #selector(NSText.copy(_:))
        case "v": action = #selector(NSText.paste(_:))
        case "x": action = #selector(NSText.cut(_:))
        case "a": action = #selector(NSText.selectAll(_:))
        case "z": action = shift ? Selector(("redo:")) : Selector(("undo:"))
        case "[": onOpacity?(-0.1); return true
        case "]": onOpacity?(0.1); return true
        // The Window menu's Reload and Always on Top.
        case "r" where !shift: onReload?(); return true
        case "t" where shift: onToggleFloat?(); return true
        case "w": performClose(nil); return true
        case "q": NSApp.terminate(nil); return true
        default: action = nil
        }
        if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        return super.performKeyEquivalent(with: event)
    }
}

/// The title bar's empty part, over a page that fills the whole window (.fullSizeContentView):
/// the page would take the mouse there, so this strip moves the window, and a double click
/// zooms it (or minimizes it) as the person's system setting says.
final class TitleBarStrip: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": if window.styleMask.contains(.miniaturizable) { window.performMiniaturize(nil) }
            case "None": break
            default: if window.styleMask.contains(.resizable) { window.performZoom(nil) }
            }
            return
        }
        window.performDrag(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    let options: Options
    var window: NSWindow!
    var webView: WKWebView!
    lazy var tracker = TerminalTracker(terminal: options.terminal, itermSession: options.itermSession)
    /// Where the window sits on the terminal: from its top-left corner, kept per page.
    var offset: CGPoint?
    var lastTerminalFrame: CGRect?
    var wasTerminalFront = true
    var isPlacing = false
    let pin = SpacePin()
    var isAlwaysOnTop = false
    var floatItem: NSMenuItem?
    /// The window's title follows the page's <title> as the person moves between pages.
    var titleWatch: NSKeyValueObservation?
    /// The page whose pid file (and deep-link mailbox) this window holds: its launch page, then
    /// whichever page the person moves to in it (Learn's ▦ leads to the games), so `/games 2048`
    /// finds a Learn window that now shows 2048. Nil while another window holds the page it shows.
    var claimedId: String?
    var urlWatch: NSKeyValueObservation?
    /// The title bar's height, measured at launch: the error page leaves this much room at the top.
    var titleBarHeight: CGFloat = 28

    init(options: Options) {
        self.options = options
    }

    /// Which of the server's pages this window shows now, by its window id; nil for anything else
    /// (the error page, a blank page before the first load).
    func serverPageId(_ url: URL?) -> String? {
        guard let url, let start = options.url, url.host == start.host, url.port == start.port else { return nil }
        return pageId(url.path)
    }

    /// Which see-through this window takes from appearance.json: Learn's, or the games' (the hub
    /// included), by the page it shows now, not the one it opened on.
    var opacityGroup: String {
        let shown = serverPageId(webView?.url) ?? claimedId ?? options.id
        return shown.hasPrefix("games") ? "games" : "learn"
    }

    /// `<pid> <port>` in a page's pid file: web/server.mjs and a second launch read it.
    func writePid(_ id: String) {
        try? "\(getpid()) \(options.url?.port ?? 0)".write(to: pidFile(id), atomically: true, encoding: .utf8)
    }

    /// Removes a page's pid file, only while it is still this window's.
    func releasePid(_ id: String) {
        let file = pidFile(id)
        guard let text = try? String(contentsOf: file, encoding: .utf8),
              text.split(separator: " ").first.map({ String($0) }) == String(getpid()) else { return }
        try? FileManager.default.removeItem(at: file)
    }

    /// After the page changed: this window now answers for the page it shows, unless another live
    /// window already does.
    func followShownPage() {
        guard let id = serverPageId(webView.url), id != claimedId else { return }
        if let held = claimedId { releasePid(held) }
        claimedId = nil
        if runningWindow(id, port: options.url?.port) == nil {
            writePid(id)
            claimedId = id
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        // The page fills the window, title bar included (.fullSizeContentView): it is told the
        // title bar's height, and that it is in the app (only here can its background be see-through).
        let probe = NSRect(x: 0, y: 0, width: 400, height: 300)
        let measured = NSWindow.frameRect(forContentRect: probe, styleMask: [.titled, .closable]).height - probe.height
        let titleBar = measured >= 16 && measured <= 60 ? measured : 28
        titleBarHeight = titleBar
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        let native = "document.documentElement.classList.add('native');document.documentElement.style.setProperty('--titlebar','\(Int(titleBar.rounded()))px');"
        config.userContentController.addUserScript(WKUserScript(source: native, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        // Learn reads wide; the games hub is a short list; a game fits its board.
        let size = options.id == "learn" ? NSSize(width: 1280, height: 860)
            : options.id == "games" ? NSSize(width: 560, height: 460) : NSSize(width: 980, height: 820)
        if tracker.isKnown {
            // Stuck to the terminal: a floating panel on every Space, full-screen ones included.
            let floating = FloatingWindow(
                contentRect: NSRect(origin: .zero, size: size),
                styleMask: [.titled, .closable, .resizable, .nonactivatingPanel, .fullSizeContentView],
                backing: .buffered, defer: false)
            floating.isFloatingPanel = true
            floating.hidesOnDeactivate = false
            floating.becomesKeyOnlyIfNeeded = false
            floating.collectionBehavior = [.fullScreenAuxiliary]
            floating.onOpacity = { [weak self] step in self?.changeOpacity(step) }
            floating.onReload = { [weak self] in self?.reloadPage(nil) }
            floating.onToggleFloat = { [weak self] in self?.toggleFloat(nil) }
            window = floating
        } else {
            window = NSWindow(
                contentRect: NSRect(origin: .zero, size: size),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered, defer: false)
        }
        window.title = options.title
        // Clear, never faded as a whole: the page's own background carries the see-through, and
        // no title-bar strip of a fixed colour sits over a light page.
        window.alphaValue = 1
        window.isOpaque = false
        window.backgroundColor = .clear
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        // This app is seldom the active one (stuck to the terminal it never is): without this, no
        // tooltip shows, the pages' title attributes included.
        window.allowsToolTipsWhenApplicationIsInactive = true

        let content = NSView(frame: NSRect(origin: .zero, size: size))
        webView.frame = content.bounds
        webView.autoresizingMask = [.width, .height]
        content.addSubview(webView)
        // Right of the traffic lights, the title bar moves the window as it always did.
        let lights = (window.standardWindowButton(.zoomButton)?.frame.maxX ?? 70) + 8
        let strip = TitleBarStrip(frame: NSRect(x: lights, y: size.height - titleBar, width: max(0, size.width - lights), height: titleBar))
        strip.autoresizingMask = [.width, .minYMargin]
        content.addSubview(strip)
        window.contentView = content
        window.makeFirstResponder(webView)
        window.delegate = self
        titleWatch = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            guard let self = self, let title = view.title, !title.isEmpty else { return }
            self.window.title = title
        }
        urlWatch = webView.observe(\.url, options: [.new]) { [weak self] _, _ in self?.followShownPage() }
        let defaults = UserDefaults.standard
        let saved = NSSize(width: defaults.double(forKey: "window.\(options.id).width"), height: defaults.double(forKey: "window.\(options.id).height"))
        if saved.width >= 320 && saved.height >= 240 { window.setContentSize(saved) }
        if defaults.object(forKey: "window.\(options.id).dx") != nil {
            offset = CGPoint(x: defaults.double(forKey: "window.\(options.id).dx"), y: defaults.double(forKey: "window.\(options.id).dy"))
        }
        window.center()
        if !tracker.isKnown { window.setFrameAutosaveName("ClaudePanel.\(options.id)") }
        follow(force: true)
        window.makeKeyAndOrderFront(nil)
        if tracker.isKnown {
            // Opened from the terminal's Space: it lives there from now on.
            pin.keep(window, terminalInView: tracker.find() != nil)
            Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.follow(force: false) }
        }

        writePid(options.id)
        claimedId = options.id
        if let url = options.url { webView.load(URLRequest(url: url)) }
        // A deep link while this window is open (`web.sh open learn --view settings`): the server
        // writes the path to <id>.open beside the pid file of the page this window holds. Load it
        // on the server's own origin (never the address shown now, which may be the error page),
        // where the page keeps its token for the session. One left from an earlier window goes first.
        try? FileManager.default.removeItem(at: pidFile(options.id).deletingPathExtension().appendingPathExtension("open"))
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self, let id = self.claimedId, let start = self.options.url else { return }
            let mailbox = pidFile(id).deletingPathExtension().appendingPathExtension("open")
            guard let text = try? String(contentsOf: mailbox, encoding: .utf8) else { return }
            try? FileManager.default.removeItem(at: mailbox)
            let path = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard path.hasPrefix("/"), !path.hasPrefix("//"),
                  let target = URL(string: path, relativeTo: start)?.absoluteURL else { return }
            self.webView.load(URLRequest(url: target))
        }
        // A free-standing window comes forward; one stuck to the terminal leaves it in front.
        if !tracker.isKnown { NSApp.activate(ignoringOtherApps: true) }
    }

    // Hiding the window with the terminal must not quit the app: only closing it does.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }

    // --- Sticking to the terminal ------------------------------------------------------

    func follow(force: Bool) {
        guard tracker.isKnown, !window.isMiniaturized else { return }
        let terminal = tracker.find()
        pin.keep(window, terminalInView: terminal != nil)
        // On another Space, or minimized: it stays where it is, on the terminal's Space.
        guard let terminal else { return }
        let box = terminal.frame
        let isFront = tracker.isFront()
        guard force || box != lastTerminalFrame || isFront != wasTerminalFront else { return }
        lastTerminalFrame = box
        wasTerminalFront = isFront
        // First time on this terminal: centred on it, below its title bar.
        let spot = offset ?? CGPoint(x: (box.width - window.frame.width) / 2, y: max(28, (box.height - window.frame.height) / 2))
        isPlacing = true
        window.setFrameOrigin(NSPoint(x: box.minX + spot.x, y: box.maxY - spot.y - window.frame.height))
        isPlacing = false
        window.level = isFront || isAlwaysOnTop ? .floating : .normal
        if !isFront && !isAlwaysOnTop && window.isOnActiveSpace {
            window.order(.above, relativeTo: Int(terminal.id))
        }
    }

    // Moved by the person (a mouse button is down): it keeps that spot on the terminal.
    func windowDidMove(_ notification: Notification) {
        guard !isPlacing, tracker.isKnown, NSEvent.pressedMouseButtons != 0, let box = lastTerminalFrame else { return }
        let frame = window.frame
        offset = CGPoint(x: frame.minX - box.minX, y: box.maxY - frame.maxY)
        UserDefaults.standard.set(offset!.x, forKey: "window.\(options.id).dx")
        UserDefaults.standard.set(offset!.y, forKey: "window.\(options.id).dy")
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        let size = window.contentRect(forFrameRect: window.frame).size
        UserDefaults.standard.set(Double(size.width), forKey: "window.\(options.id).width")
        UserDefaults.standard.set(Double(size.height), forKey: "window.\(options.id).height")
        windowDidMove(notification)
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let id = claimedId { releasePid(id) }
    }

    // The page's own server stays in the window; anything else (YouTube, docs, lichess) opens in the browser.
    func isOwn(_ url: URL?) -> Bool {
        guard let url, let start = options.url else { return true }
        return url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" || (url.host == start.host && url.port == start.port)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        if action.targetFrame?.isMainFrame == false || isOwn(url) {
            decisionHandler(.allow)
            return
        }
        if let url, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    // target="_blank" links: never a new web view, always the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") {
            if isOwn(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    // The pages ask before a remove with their own two-click buttons, but keep confirm() working.
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // A load that another one replaced (a deep link while the page was loading) is no failure.
        let failure = error as NSError
        if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
        if failure.domain == "WebKitErrorDomain" && failure.code == 102 { return }
        showProblem(error.localizedDescription)
    }

    /// The page that couldn't load, in the colour scheme every window wears (appearance.json,
    /// checked: only #RRGGBB colours reach the page), named as this window is.
    func showProblem(_ text: String) {
        let escape = { (raw: String) -> String in
            raw.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        }
        let look = cleanAppearance(readAppearance() ?? [:], over: nil)
        let colors = (look["colors"] as? [String: String]) ?? [:]
        let bg = colors["bg"] ?? "#1C1D20"
        let ink = colors["text"] ?? "#E8E6E3"
        let command = options.id == "learn" ? "/learn" : "/games"
        let top = Int(titleBarHeight.rounded()) + 24
        let html = "<!doctype html><meta charset='utf-8'><body style='margin:0;padding:\(top)px 40px 40px;font:14px -apple-system,sans-serif;color:\(ink);background:\(bg)'>"
            + "<h3>Couldn't reach the \(escape(options.title)) page</h3><p style='opacity:.7'>\(escape(text))</p>"
            + "<p style='opacity:.7'>Run \(command) again in Claude Code.</p></body>"
        webView.loadHTMLString(html, baseURL: nil)
    }

    // Above everything, even other apps (it already floats above the terminal while that is in front).
    @objc func toggleFloat(_ sender: Any?) {
        isAlwaysOnTop.toggle()
        window.level = isAlwaysOnTop || tracker.isFront() ? .floating : .normal
        floatItem?.state = isAlwaysOnTop ? .on : .off
    }

    @objc func reloadPage(_ sender: Any?) { webView.reload() }

    /// ⌘[ more see-through, ⌘] more solid, by 10%: the background only (text stays solid), for every
    /// Learn window or every game window at once, kept in appearance.json. This page shows it at
    /// once; the others (and this one, fully) follow within two seconds (shared/look.js polls).
    func changeOpacity(_ step: CGFloat) {
        let group = opacityGroup
        var saved = readAppearance() ?? [:]
        var opacity = (saved["opacity"] as? [String: Any]) ?? [:]
        let now = (opacity[group] as? NSNumber)?.doubleValue ?? defaultOpacity[group] ?? 1
        opacity[group] = min(max(now + Double(step), minOpacity), 1)
        saved["opacity"] = opacity
        let next = cleanAppearance(saved, over: nil)
        guard writeAppearance(next) else { return }
        webView.callAsyncJavaScript(
            "if (window.ClaudeTheme) window.ClaudeTheme.applyAppearance(a, g)",
            arguments: ["a": next, "g": group], in: nil, in: .page, completionHandler: nil)
    }

    @objc func moreTransparent(_ sender: Any?) { changeOpacity(-0.1) }
    @objc func lessTransparent(_ sender: Any?) { changeOpacity(0.1) }

    // Without an Edit menu, Cmd+C / Cmd+V / Cmd+A never reach the page's text boxes.
    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide \(options.title)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit \(options.title)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        let float = NSMenuItem(title: "Always on Top", action: #selector(toggleFloat(_:)), keyEquivalent: "t")
        float.keyEquivalentModifierMask = [.command, .shift]
        windowMenu.addItem(float)
        floatItem = float
        windowMenu.addItem(withTitle: "More See-through", action: #selector(moreTransparent(_:)), keyEquivalent: "[")
        windowMenu.addItem(withTitle: "Less See-through", action: #selector(lessTransparent(_:)), keyEquivalent: "]")
        windowMenu.addItem(.separator())
        // A window stuck to the terminal hides with it instead, and has no minimize button.
        if !tracker.isKnown {
            windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        }
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }
}

// --- The floating panel ---------------------------------------------------------------

/// One JSON line on stdout for the plugin; false once nobody reads it (the session is gone).
@discardableResult
func sendEvent(_ event: String) -> Bool {
    let line = "{\"event\":\"\(event)\"}\n"
    return line.withCString { fputs($0, stdout) } >= 0 && fflush(stdout) == 0
}

/// The terminal app's name in the window list, from TERM_PROGRAM.
func terminalOwners(_ program: String) -> [String] {
    switch program {
    case "iTerm.app": return ["iTerm2"]
    case "Apple_Terminal": return ["Terminal"]
    case "ghostty": return ["Ghostty"]
    case "WezTerm": return ["WezTerm", "wezterm-gui"]
    case "vscode": return ["Code", "Cursor", "Windsurf"]
    case "WarpTerminal": return ["Warp"]
    default: return ["iTerm2", "Terminal", "Ghostty", "WezTerm", "Warp", "kitty", "Alacritty"]
    }
}

// --- Following the terminal ----------------------------------------------------------

/// Finds the chat's terminal window and says whether it is in front: the panel and every
/// Learn or game window stick to it.
final class TerminalTracker {
    let terminal: String
    let itermSession: String
    var terminalWindow: CGWindowID?

    init(terminal: String, itermSession: String) {
        self.terminal = terminal
        self.itermSession = itermSession
    }

    var isKnown: Bool { !terminal.isEmpty }

    /// The chat's terminal window, its frame in AppKit's coordinates. iTerm2 names it exactly by its session id (AppleScript,
    /// asked once: macOS asks the person to allow it); anywhere else, or without that
    /// permission, the terminal app's frontmost window on screen.
    func find() -> (id: CGWindowID, frame: CGRect)? {
        guard let found = findAnywhere() else { return nil }
        // Mid-swipe, macOS reports the window sliding off the display: that is no place to follow it to.
        let isOnDisplay = NSScreen.screens.contains { screen in
            let overlap = screen.frame.intersection(found.frame)
            return overlap.width * overlap.height >= 0.9 * found.frame.width * found.frame.height
        }
        return isOnDisplay ? found : nil
    }

    private func findAnywhere() -> (id: CGWindowID, frame: CGRect)? {
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        let owners = terminalOwners(terminal)
        let frameOf: ([String: Any]) -> CGRect? = { info in
            guard let bounds = info[kCGWindowBounds as String] as? NSDictionary else { return nil }
            return CGRect(dictionaryRepresentation: bounds)
        }
        if let wanted = terminalWindow,
           let info = list.first(where: { ($0[kCGWindowNumber as String] as? CGWindowID) == wanted }),
           let frame = frameOf(info) {
            return (wanted, appKitFrame(frame))
        }
        if terminalWindow == nil, let id = itermWindowNumber(),
           let info = list.first(where: { ($0[kCGWindowNumber as String] as? CGWindowID) == id }),
           let frame = frameOf(info) {
            terminalWindow = id
            return (id, appKitFrame(frame))
        }
        // Front to back: the first normal-level window of the terminal app.
        for info in list {
            guard let owner = info[kCGWindowOwnerName as String] as? String, owners.contains(owner),
                  (info[kCGWindowLayer as String] as? Int) == 0,
                  let id = info[kCGWindowNumber as String] as? CGWindowID,
                  let frame = frameOf(info), frame.width > 200, frame.height > 120 else { continue }
            return (id, appKitFrame(frame))
        }
        return nil
    }

    var itermAsked = false
    var itermWindow: CGWindowID?

    /// iTerm2's window id is its window number, the same as the window list's.
    func itermWindowNumber() -> CGWindowID? {
        if itermAsked { return itermWindow }
        itermAsked = true
        guard terminal == "iTerm.app", let uuid = itermSession.split(separator: ":").last else { return nil }
        let script = """
        tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if unique id of s is "\(uuid)" then return id of w
              end repeat
            end repeat
          end repeat
        end tell
        return 0
        """
        var error: NSDictionary?
        let result = NSAppleScript(source: script)?.executeAndReturnError(&error)
        let number = result.map { CGWindowID($0.int32Value) } ?? 0
        itermWindow = number > 0 ? number : nil
        return itermWindow
    }

    /// The terminal's window in the window list's coordinates (top-left origin) to AppKit's.
    func appKitFrame(_ frame: CGRect) -> CGRect {
        let primary = NSScreen.screens.first?.frame.height ?? 0
        return CGRect(x: frame.minX, y: primary - frame.maxY, width: frame.width, height: frame.height)
    }

    /// The terminal, or one of this app's windows, is the app in front.
    func isFront() -> Bool {
        let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
        return terminalOwners(terminal).contains(front) || front == "Claude Panel" || front == "ClaudePanel"
    }
}

/// Keeps a window on the terminal's Space, and only there. macOS then carries it with that
/// Space when the person swipes, so it never shows on, or flickers over, another app's Space.
/// It is shown first while the terminal is in view, and moved over only after the terminal has
/// been steadily in view without it for half a second (never in the middle of a swipe).
final class SpacePin {
    var hasShown = false
    private var strayTicks = 0
    private var waitTicks = 0

    /// Called on every tick (0.1 s) with whether the terminal's window is on screen.
    func keep(_ window: NSWindow, terminalInView: Bool) {
        guard terminalInView else {
            strayTicks = 0
            // No terminal window found at all for 3 s: show it where the person is.
            waitTicks += 1
            if !hasShown && waitTicks > 30 { show(window) }
            return
        }
        if !hasShown {
            show(window)
            return
        }
        if window.isOnActiveSpace || !window.isVisible {
            strayTicks = 0
            return
        }
        strayTicks += 1
        if strayTicks >= 5 {
            strayTicks = 0
            show(window)
        }
    }

    /// Onto the Space in front (the terminal's), full-screen ones included, and left there.
    private func show(_ window: NSWindow) {
        hasShown = true
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.orderFrontRegardless()
        window.collectionBehavior = [.fullScreenAuxiliary]
    }
}

/// A strip over the header's empty part (between the open/closed mark and the marks on the right,
/// as the page reports them): dragging it moves the panel (the page can't); a double click opens
/// or closes it, as on Windows.
final class DragStrip: NSView {
    var onDragEnd: (() -> Void)?
    var onDoubleClick: (() -> Void)?
    // performDrag follows the mouse until it is let go: only then is the new spot kept.
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            onDoubleClick?()
            return
        }
        window?.performDrag(with: event)
        onDragEnd?()
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The corner grip (bottom-left: the panel hangs from the terminal's top-right corner, so that
/// corner stays put). Dragging it sizes the panel; a double click goes back to fitting its content.
final class ResizeGrip: NSView {
    var onResize: ((CGFloat, CGFloat) -> Void)?
    var onEnd: (() -> Void)?
    var onReset: (() -> Void)?
    private var start = NSPoint.zero

    /// The diagonal resize cursor macOS shows on window corners (asked for by name, so a macOS
    /// without it gets the crosshair instead).
    static let cursor: NSCursor = {
        let name = Selector(("_windowResizeNorthEastSouthWestCursor"))
        let cursorClass: AnyObject = NSCursor.self
        if cursorClass.responds(to: name), let found = cursorClass.perform(name)?.takeUnretainedValue() as? NSCursor { return found }
        return .crosshair
    }()

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: ResizeGrip.cursor) }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            onReset?()
            return
        }
        start = NSEvent.mouseLocation
    }

    override func mouseDragged(with event: NSEvent) {
        let now = NSEvent.mouseLocation
        // Left grows it wider, down grows it taller.
        onResize?(start.x - now.x, start.y - now.y)
    }

    override func mouseUp(with event: NSEvent) { onEnd?() }
}

/// Clicks land on the first press, without bringing the panel's app forward.
final class FirstClickWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class PanelDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, NSWindowDelegate {
    let options: Options
    let stateURL: URL
    var panel: FloatingPanel!
    var webView: WKWebView!
    var isLoaded = false
    var lastText: String?
    var missingSince: Date?
    var ticks = 0
    /// Where the person dragged it, from the terminal window's top-right corner (as the WPF panel keeps dx/dy).
    var offset = CGPoint(x: UserDefaults.standard.double(forKey: "panel.dx"), y: UserDefaults.standard.double(forKey: "panel.dy"))
    lazy var tracker = TerminalTracker(terminal: options.terminal, itermSession: options.itermSession)
    var lastTerminalFrame: CGRect?
    var isPlacing = false
    /// The page's own height (all its content); what shows is the person's chosen height, if any.
    var height: CGFloat = 120
    /// Sized by the person with the corner grip, and kept: a width, and a height (0: fit the content).
    var width: CGFloat = { let w = UserDefaults.standard.double(forKey: "panel.width"); return w >= 240 ? CGFloat(w) : 340 }()
    var chosenHeight: CGFloat = CGFloat(UserDefaults.standard.double(forKey: "panel.height"))
    var isCollapsed = false
    var resizeFrom: (width: CGFloat, height: CGFloat)?
    var wasSized = false
    /// The tallest it may be while fitting its content: down to the terminal's bottom edge, no further.
    var limit = CGFloat.greatestFiniteMagnitude
    var shownHeight: CGFloat {
        if isCollapsed { return height }
        if chosenHeight >= 90 { return chosenHeight }
        return min(height, limit)
    }
    let margin: CGFloat = 12
    var strip: DragStrip!
    var grip: ResizeGrip!
    /// Where the page's header row ends, where its open/closed mark ends and its marks begin (from
    /// the right), and its grip's size, in points: the page posts them ('chrome') whenever they change.
    var chrome: (header: CGFloat, left: CGFloat, icons: CGFloat, grip: CGFloat) = (33, 29, 77, 14)
    var appearanceStamp = ""

    init(options: Options) {
        self.options = options
        stateURL = URL(fileURLWithPath: options.panel ?? "")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN)
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "panel")
        // The saved colours before the page's first paint, so a Paper panel never shows Ember first.
        // Only checked fields (a preset name of letters, #RRGGBB colours, numbers), as JSON: data.
        let firstLook = readAppearance().map { cleanAppearance($0, over: nil) }
        let firstJSON = firstLook.flatMap { try? JSONSerialization.data(withJSONObject: $0) }.flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        config.userContentController.addUserScript(WKUserScript(source: "window.__appearance = \(firstJSON);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = FirstClickWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]

        panel = FloatingPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        // On every Space, full-screen ones included: a terminal in full screen has a Space of its
        // own, which an ordinary window never joins. It shows only where the terminal is.
        panel.collectionBehavior = [.fullScreenAuxiliary]
        panel.delegate = self
        // Never faded as a whole: the page's card fill carries the panel's see-through (appearance.json).
        panel.alphaValue = 1
        // This app is never the active one (an accessory, a panel that doesn't activate): without
        // this no tooltip shows, and the marks' meanings live in theirs.
        panel.allowsToolTipsWhenApplicationIsInactive = true

        let content = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        content.addSubview(webView)
        strip = DragStrip(frame: .zero)
        strip.autoresizingMask = [.minYMargin, .width]
        strip.onDragEnd = { [weak self] in self?.keepDraggedSpot() }
        strip.onDoubleClick = { [weak self] in self?.webView.evaluateJavaScript("window.toggleCollapsed()", completionHandler: nil) }
        content.addSubview(strip)
        grip = ResizeGrip(frame: .zero)
        grip.autoresizingMask = [.maxXMargin, .maxYMargin]
        grip.onResize = { [weak self] dx, dy in self?.resize(dx: dx, dy: dy) }
        grip.onEnd = { [weak self] in self?.keepSize() }
        grip.onReset = { [weak self] in self?.resetSize() }
        // The page's own grip lies under this view, so its title never shows: this is its tooltip.
        grip.toolTip = "Drag to resize; double-click to fit"
        content.addSubview(grip)
        panel.contentView = content
        layoutChrome()

        if let html = options.html {
            let url = URL(fileURLWithPath: html)
            // The page loads web/public/shared/theme.js and theme.css: it may read the whole plugin.
            let parent = url.deletingLastPathComponent().deletingLastPathComponent()
            var access = parent
            if let root = options.root, url.standardizedFileURL.path.hasPrefix(URL(fileURLWithPath: root).standardizedFileURL.path) {
                access = URL(fileURLWithPath: root, isDirectory: true)
            }
            webView.loadFileURL(url, allowingReadAccessTo: access)
        }

        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "loaded":
            isLoaded = true
            lastText = nil
            pushPresets()
            pushAppearance(force: true)
            pushReleases()
            pushPrefs()
            readState()
            place(force: true)
            sendEvent("ready")
        case "height":
            if let h = body["height"] as? Double, abs(CGFloat(h) - height) >= 1 {
                height = CGFloat(h)
                if resizeFrom == nil { place(force: true) }
            }
        case "chrome":
            let number = { (key: String) -> CGFloat? in (body[key] as? NSNumber).map { CGFloat($0.doubleValue) } }
            chrome = (header: number("header") ?? chrome.header, left: number("left") ?? chrome.left,
                      icons: number("icons") ?? chrome.icons, grip: number("grip") ?? chrome.grip)
            layoutChrome()
        case "collapsed":
            isCollapsed = body["value"] as? Bool ?? false
            UserDefaults.standard.set(isCollapsed, forKey: "panel.collapsed")
            place(force: true)
        case "tab":
            // A tab the person clicked, with what the panel had seen then ("seen": the plan's title
            // and the newest run): the next panel opens on it unless a plan or run came since.
            // Releases is a look, not a place to come back to: it leaves the pick before it as it
            // was. Null when something new ended that pick.
            let defaults = UserDefaults.standard
            if let name = body["value"] as? String, ["phases", "tests", "learn"].contains(name) {
                defaults.set(name, forKey: "panel.tab")
                let seen = body["seen"] as? [String: Any]
                let plan = seen?["plan"] as? String
                let focus = seen?["focus"] as? String
                if seen != nil && (plan?.count ?? 0) <= 1000 && (focus?.count ?? 0) <= 200 {
                    var marks: [String: String] = [:]
                    if let plan = plan { marks["plan"] = plan }
                    if let focus = focus { marks["focus"] = focus }
                    defaults.set(marks, forKey: "panel.tabSeen")
                } else {
                    // Not known (or not sane): the next panel takes a plan or a live run it starts with as new.
                    defaults.removeObject(forKey: "panel.tabSeen")
                }
            } else if body["value"] is NSNull {
                defaults.removeObject(forKey: "panel.tab")
                defaults.removeObject(forKey: "panel.tabSeen")
            }
        case "open":
            // A Learn view ("settings" from Custom colours, "course" from Carry on reading) or a game.
            if let page = body["page"] as? String { openPage(page, view: body["view"] as? String, course: body["course"] as? String) }
        case "appearance":
            // A swatch or a see-through bar in the ◐ strip: every window follows the file.
            if let value = body["value"] as? [String: Any], writeAppearance(cleanAppearance(value, over: readAppearance())) {
                // This write is no news to the page that made it.
                appearanceStamp = fileStamp(appearanceURL())
            }
        case "seen":
            // The Releases tab was opened: its dot stays off until a newer version comes.
            if let version = body["version"] as? String, !version.isEmpty, version.count <= 40 {
                UserDefaults.standard.set(version, forKey: "panel.seenRelease")
            }
        case "close":
            // ✕: hidden until something new (the plugin starts it again then).
            sendEvent("closed")
            NSApp.terminate(nil)
        default: break
        }
    }

    /// `web.sh open <page> [--view <view>] [--course <id>]`: the window comes forward if it is open.
    func openPage(_ page: String, view: String? = nil, course: String? = nil) {
        guard let root = options.root, page.range(of: "^(learn|games(/[a-z0-9]+)?)$", options: .regularExpression) != nil else { return }
        var arguments = ["\(root)/web/web.sh", "open", page]
        if let view, view.range(of: "^[a-z]{1,20}$", options: .regularExpression) != nil { arguments += ["--view", view] }
        if let course, course.range(of: "^[A-Za-z0-9_.-]{1,160}$", options: .regularExpression) != nil { arguments += ["--course", course] }
        arguments += ["--terminal", options.terminal, "--iterm-session", options.itermSession]
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
    }

    // --- The appearance and the releases, pushed to the page as data -------------------

    /// appearance.json as saved (null when there is none: the page shows Ember), when it changed.
    func pushAppearance(force: Bool) {
        guard isLoaded else { return }
        let stamp = fileStamp(appearanceURL())
        if !force && stamp == appearanceStamp { return }
        appearanceStamp = stamp
        let value: Any = readAppearance().map { $0 as Any } ?? NSNull()
        webView.callAsyncJavaScript("window.setAppearance(a)", arguments: ["a": value], in: nil, in: .page, completionHandler: nil)
    }

    /// The presets that ship with the plugin (widget/Presets.json), for the ◐ strip's swatches.
    func pushPresets() {
        guard let root = options.root,
              let presets = readJSONObject(URL(fileURLWithPath: root).appendingPathComponent("widget/Presets.json"))?["presets"] as? [Any] else { return }
        webView.callAsyncJavaScript("window.setPresets(p)", arguments: ["p": presets], in: nil, in: .page, completionHandler: nil)
    }

    /// The Releases tab: this copy's version (plugin.json), every release (releases.json), and the
    /// version the person last opened the tab at.
    func pushReleases() {
        guard let root = options.root else { return }
        let base = URL(fileURLWithPath: root)
        let releases = (readJSONObject(base.appendingPathComponent("releases.json"))?["releases"] as? [Any]) ?? []
        var value: [String: Any] = ["version": NSNull(), "releases": releases, "seen": NSNull()]
        if let version = readJSONObject(base.appendingPathComponent(".claude-plugin/plugin.json"))?["version"] as? String { value["version"] = version }
        if let seen = UserDefaults.standard.string(forKey: "panel.seenRelease") { value["seen"] = seen }
        webView.callAsyncJavaScript("window.setReleases(r)", arguments: ["r": value], in: nil, in: .page, completionHandler: nil)
    }

    /// What the person left the last panel as, as the WPF panel keeps it: the tab they picked
    /// (Releases is a look, not a place to come back to), what that panel had seen with it, and
    /// whether it was collapsed. Given before the first state, so the page can tell whether that
    /// state is news (a new plan or run brings its tab forward) or where the panel starts.
    func pushPrefs() {
        let defaults = UserDefaults.standard
        let savedTab = defaults.string(forKey: "panel.tab") ?? ""
        isCollapsed = defaults.bool(forKey: "panel.collapsed")
        var prefs: [String: Any] = ["tab": NSNull(), "seen": NSNull(), "collapsed": isCollapsed]
        if ["phases", "tests", "learn"].contains(savedTab) {
            prefs["tab"] = savedTab
            if let saved = defaults.dictionary(forKey: "panel.tabSeen") {
                var seen: [String: Any] = ["plan": NSNull(), "focus": NSNull()]
                if let plan = saved["plan"] as? String { seen["plan"] = plan }
                if let focus = saved["focus"] as? String { seen["focus"] = focus }
                prefs["seen"] = seen
            }
        }
        webView.callAsyncJavaScript("window.setPrefs(p)", arguments: ["p": prefs], in: nil, in: .page, completionHandler: nil)
    }

    /// The drag strip over the header between its marks, and the grip view over the page's grip.
    func layoutChrome() {
        guard let content = panel?.contentView else { return }
        let size = content.bounds.size
        let header = max(0, min(chrome.header, size.height))
        strip.frame = NSRect(x: chrome.left, y: size.height - header, width: max(0, size.width - chrome.left - chrome.icons), height: header)
        grip.frame = NSRect(x: 0, y: 0, width: chrome.grip, height: chrome.grip)
        grip.isHidden = chrome.grip < 1
        panel.invalidateCursorRects(for: grip)
    }

    func tick() {
        ticks += 1
        if ticks % 3 == 0 { readState() }
        // Another window (or Learn's settings) changed the colour scheme or see-through.
        if ticks % 10 == 0 { pushAppearance(force: false) }
        if ticks % 50 == 0 && !sendEvent("alive") { NSApp.terminate(nil) }
        place(force: false)
    }

    func readState() {
        guard isLoaded else { return }
        guard let text = try? String(contentsOf: stateURL, encoding: .utf8) else {
            // The session is over: its file goes, and the panel with it.
            if missingSince == nil { missingSince = Date() }
            if let since = missingSince, Date().timeIntervalSince(since) > 2 { NSApp.terminate(nil) }
            return
        }
        missingSince = nil
        if text == lastText { return }
        lastText = text
        // The file is data, never code: parsed here, handed to the page as an argument.
        guard let data = text.data(using: .utf8), let state = try? JSONSerialization.jsonObject(with: data) else { return }
        webView.callAsyncJavaScript("window.render(state)", arguments: ["state": state], in: nil, in: .page, completionHandler: nil)
    }

    func place(force: Bool) {
        guard isLoaded else { return }
        let terminal = tracker.find()
        // Shown on the terminal's Space and left there: a swipe carries it, nothing to hide.
        guard let terminal else {
            if force && !pin.hasShown { placeAt(NSScreen.main?.visibleFrame ?? .zero) }
            pin.keep(panel, terminalInView: false)
            return
        }
        let frame = terminal.frame
        // Above the terminal while it (or this panel) is in front; behind whatever the person brings forward.
        let isTerminalFront = tracker.isFront()
        if force || frame != lastTerminalFrame || isTerminalFront != wasTerminalFront {
            lastTerminalFrame = frame
            wasTerminalFront = isTerminalFront
            placeAt(frame)
            panel.level = isTerminalFront ? .floating : .normal
            if !isTerminalFront && panel.isOnActiveSpace { panel.order(.above, relativeTo: Int(terminal.id)) }
        }
        pin.keep(panel, terminalInView: true)
    }

    var wasTerminalFront = true
    let pin = SpacePin()

    func placeAt(_ box: CGRect) {
        let x = box.maxX - width - margin + offset.x
        let top = box.maxY - margin - 28 - offset.y
        // Fitting its content, it stops at the terminal's bottom edge (a long plan or the Releases
        // list scrolls instead of running off the screen).
        limit = max(90, top - box.minY - margin)
        isPlacing = true
        panel.setFrame(NSRect(x: x, y: top - shownHeight, width: width, height: shownHeight), display: true)
        layoutChrome()
        // Sized by the person, or cut to the limit: the page fills the window and its body scrolls.
        let isSized = !isCollapsed && (chosenHeight >= 90 || height > limit)
        if isSized != wasSized {
            wasSized = isSized
            webView.evaluateJavaScript("window.setSized(\(isSized))", completionHandler: nil)
        }
        isPlacing = false
    }

    // --- Sizing with the corner grip ---------------------------------------------------

    func resize(dx: CGFloat, dy: CGFloat) {
        if resizeFrom == nil { resizeFrom = (width, shownHeight) }
        guard let from = resizeFrom, let box = lastTerminalFrame ?? NSScreen.main?.visibleFrame else { return }
        width = min(max(from.width + dx, 240), 900)
        if !isCollapsed { chosenHeight = min(max(from.height + dy, 90), 1200) }
        placeAt(box)
    }

    func keepSize() {
        resizeFrom = nil
        UserDefaults.standard.set(Double(width), forKey: "panel.width")
        UserDefaults.standard.set(Double(chosenHeight), forKey: "panel.height")
    }

    func resetSize() {
        width = 340
        chosenHeight = 0
        keepSize()
        place(force: true)
    }

    // A drag by the person (never a move macOS makes on its own): keep where it landed,
    // from the terminal's top-right corner.
    func keepDraggedSpot() {
        guard let box = lastTerminalFrame else { return }
        let frame = panel.frame
        offset = CGPoint(x: frame.minX - (box.maxX - width - margin), y: (box.maxY - margin - 28) - frame.maxY)
        UserDefaults.standard.set(offset.x, forKey: "panel.dx")
        UserDefaults.standard.set(offset.y, forKey: "panel.dy")
    }
}

var options = readOptions()
if options.tokenOnStdin, let line = readLine(), let url = options.url,
   line.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil {
    options.url = URL(string: "\(url.absoluteString)#token=\(line)")
}
let app = NSApplication.shared
if options.panel != nil {
    app.setActivationPolicy(.accessory)
    let delegate = PanelDelegate(options: options)
    app.delegate = delegate
    app.run()
} else {
    if let existing = runningWindow(options.id, port: options.url?.port) {
        existing.activate()
        exit(0)
    }
    // Stuck to a terminal: no Dock icon, and never pulls the person off the terminal's Space.
    app.setActivationPolicy(options.terminal.isEmpty ? .regular : .accessory)
    let delegate = AppDelegate(options: options)
    app.delegate = delegate
    app.run()
}
