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

/// How see-through a window is (1: solid), kept under `key`; 85% until the person changes it.
func savedOpacity(_ key: String) -> CGFloat {
    let value = UserDefaults.standard.double(forKey: key)
    return value >= 0.3 && value <= 1 ? CGFloat(value) : 0.85
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

/// A Learn or game window that can float over a full-screen terminal: a panel that takes the
/// keyboard without bringing this app forward (so the terminal's Space stays). The menu bar
/// isn't this app's then, so its shortcuts are handled here.
final class FloatingWindow: NSPanel {
    var onOpacity: ((CGFloat) -> Void)?
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
        case "w": performClose(nil); return true
        case "q": NSApp.terminate(nil); return true
        default: action = nil
        }
        if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        return super.performKeyEquivalent(with: event)
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

    init(options: Options) {
        self.options = options
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        let size = options.id == "learn" ? NSSize(width: 1280, height: 860) : NSSize(width: 980, height: 820)
        if tracker.isKnown {
            // Stuck to the terminal: a floating panel on every Space, full-screen ones included.
            let floating = FloatingWindow(
                contentRect: NSRect(origin: .zero, size: size),
                styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
                backing: .buffered, defer: false)
            floating.isFloatingPanel = true
            floating.hidesOnDeactivate = false
            floating.becomesKeyOnlyIfNeeded = false
            floating.collectionBehavior = [.fullScreenAuxiliary]
            floating.onOpacity = { [weak self] step in self?.changeOpacity(step) }
            window = floating
        } else {
            window = NSWindow(
                contentRect: NSRect(origin: .zero, size: size),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered, defer: false)
        }
        window.title = options.title
        window.alphaValue = savedOpacity("window.\(options.id).opacity")
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0.08, green: 0.085, blue: 0.1, alpha: 1)
        window.contentView = webView
        window.delegate = self
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

        if let url = options.url { webView.load(URLRequest(url: url)) }
        try? "\(getpid()) \(options.url?.port ?? 0)".write(to: pidFile(options.id), atomically: true, encoding: .utf8)
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
        try? FileManager.default.removeItem(at: pidFile(options.id))
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
        showProblem(error.localizedDescription)
    }

    func showProblem(_ text: String) {
        let escaped = text.replacingOccurrences(of: "<", with: "&lt;")
        webView.loadHTMLString(
            "<body style='font:14px -apple-system;color:#ccc;background:#141519;padding:40px'><h3>Couldn't reach Learn's server</h3><p>\(escaped)</p><p>Run /learn again in Claude Code.</p></body>",
            baseURL: nil)
    }

    // Above everything, even other apps (it already floats above the terminal while that is in front).
    @objc func toggleFloat(_ sender: NSMenuItem) {
        isAlwaysOnTop.toggle()
        window.level = isAlwaysOnTop || tracker.isFront() ? .floating : .normal
        sender.state = isAlwaysOnTop ? .on : .off
    }

    @objc func reloadPage(_ sender: Any?) { webView.reload() }

    /// ⌘[ more see-through, ⌘] more solid: 30% to 100%, kept per page.
    func changeOpacity(_ step: CGFloat) {
        let value = min(max(window.alphaValue + step, 0.3), 1)
        window.alphaValue = value
        UserDefaults.standard.set(Double(value), forKey: "window.\(options.id).opacity")
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
        windowMenu.addItem(withTitle: "More See-through", action: #selector(moreTransparent(_:)), keyEquivalent: "[")
        windowMenu.addItem(withTitle: "Less See-through", action: #selector(lessTransparent(_:)), keyEquivalent: "]")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
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

/// A strip over the header's empty part: dragging it moves the panel (the page can't).
final class DragStrip: NSView {
    var onDragEnd: (() -> Void)?
    // performDrag follows the mouse until it is let go: only then is the new spot kept.
    override func mouseDown(with event: NSEvent) {
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

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }

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
    var shownHeight: CGFloat { isCollapsed || chosenHeight < 90 ? height : chosenHeight }
    let margin: CGFloat = 12

    init(options: Options) {
        self.options = options
        stateURL = URL(fileURLWithPath: options.panel ?? "")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN)
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "panel")
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
        panel.alphaValue = savedOpacity("panel.opacity")

        let content = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        content.addSubview(webView)
        let strip = DragStrip(frame: NSRect(x: 0, y: height - 30, width: width - 90, height: 30))
        strip.autoresizingMask = [.minYMargin, .width]
        strip.onDragEnd = { [weak self] in self?.keepDraggedSpot() }
        content.addSubview(strip)
        let grip = ResizeGrip(frame: NSRect(x: 0, y: 0, width: 16, height: 16))
        grip.autoresizingMask = [.maxXMargin, .maxYMargin]
        grip.onResize = { [weak self] dx, dy in self?.resize(dx: dx, dy: dy) }
        grip.onEnd = { [weak self] in self?.keepSize() }
        grip.onReset = { [weak self] in self?.resetSize() }
        content.addSubview(grip)
        panel.contentView = content

        if let html = options.html {
            let url = URL(fileURLWithPath: html)
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }

        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "loaded":
            isLoaded = true
            lastText = nil
            readState()
            place(force: true)
            sendEvent("ready")
        case "height":
            if let h = body["height"] as? Double, abs(CGFloat(h) - height) >= 1 {
                height = CGFloat(h)
                if resizeFrom == nil { place(force: true) }
            }
        case "collapsed":
            isCollapsed = body["value"] as? Bool ?? false
            place(force: true)
        case "open":
            if let page = body["page"] as? String { openPage(page) }
        case "opacity":
            // ◐ steps through 100, 85, 70 and 55%.
            let steps: [CGFloat] = [1, 0.85, 0.7, 0.55]
            let now = steps.firstIndex(where: { abs($0 - panel.alphaValue) < 0.05 }) ?? 0
            panel.alphaValue = steps[(now + 1) % steps.count]
            UserDefaults.standard.set(Double(panel.alphaValue), forKey: "panel.opacity")
        case "close":
            // ✕: hidden until something new (the plugin starts it again then).
            sendEvent("closed")
            NSApp.terminate(nil)
        default: break
        }
    }

    func openPage(_ page: String) {
        guard let root = options.root else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = ["\(root)/web/web.sh", "open", page, "--terminal", options.terminal, "--iterm-session", options.itermSession]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
    }

    func tick() {
        ticks += 1
        if ticks % 3 == 0 { readState() }
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
        isPlacing = true
        panel.setFrame(NSRect(x: x, y: top - shownHeight, width: width, height: shownHeight), display: true)
        let isSized = !isCollapsed && chosenHeight >= 90
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
