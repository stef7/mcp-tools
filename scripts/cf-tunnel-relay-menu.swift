// CF Tunnel Relay.app: a menu bar app that runs scripts/cf-tunnel-relay.mjs, which in turn runs
// cloudflared for tunnel WMac. No LaunchAgent and no background item: the app is the only thing
// that keeps them going, it sits in System Settings -> General -> Login Items -> Open at Login,
// and quitting it stops both.
//
// build-cf-tunnel-relay-app.sh builds it with `xcrun swiftc` into ~/Applications, noting in its
// Info.plist (key CFTunnelRelay) where the relay script, Node and cloudflared were at the time.
// Everything else happens here: the tunnel token is asked for on first run (and from the menu)
// and kept in the login Keychain as the item `cf-tunnel-relay`, never in a file or on a command
// line; the domain lists are set from the menu.
//
// The relay's standard input is a pipe from this app that is never written to: if the app goes
// without stopping it (a crash, a force quit), the pipe closes and the relay stops itself and
// cloudflared, so nothing is left running that the menu bar does not show.
//
// The icon:  cloud filled    on: relay up and cloudflared connected to Cloudflare
//            cloud with !    on, but the relay or cloudflared is not up yet (or keeps failing)
//            cloud slashed   off: neither is running
import AppKit
import ServiceManagement

let errLog = "/tmp/cf-tunnel-relay.err"
let keychainItem = "cf-tunnel-relay"
let config = Bundle.main.object(forInfoDictionaryKey: "CFTunnelRelay") as? [String: String] ?? [:]
/// Settings passed to the relay as they are; the menu sets the first two, `defaults write
/// local.cf-tunnel-relay CHROME_PATH …` the others.
let relaySettings = ["ALLOW_DOMAINS", "BROWSER_ALLOW_DOMAINS", "CHROME_PATH", "CF_TUNNEL_RELAY_PROFILE"]

@discardableResult
func run(_ path: String, _ args: [String], input: String? = nil) -> (status: Int32, output: String) {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: path)
  p.arguments = args
  let out = Pipe()
  p.standardOutput = out
  p.standardError = out
  let inPipe = Pipe()
  p.standardInput = input == nil ? FileHandle.nullDevice as Any : inPipe as Any
  do { try p.run() } catch { return (-1, "\(error)") }
  if let input = input {
    inPipe.fileHandleForWriting.write(Data(input.utf8))
    try? inPipe.fileHandleForWriting.close()
  }
  // Read before waiting, so a full pipe cannot hold the program up.
  let data = out.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  return (p.terminationStatus, String(decoding: data, as: UTF8.self))
}

/// The program at the path the build noted, or else wherever a login shell finds it now (after a
/// Node upgrade, say).
func locate(_ key: String, _ name: String) -> String? {
  if let noted = config[key], FileManager.default.isExecutableFile(atPath: noted) { return noted }
  for dir in ["/opt/homebrew/bin", "/usr/local/bin"]
  where FileManager.default.isExecutableFile(atPath: "\(dir)/\(name)") {
    return "\(dir)/\(name)"
  }
  let found = run("/bin/zsh", ["-ilc", "command -v \(name)"]).output
    .split(separator: "\n").last.map(String.init)?.trimmingCharacters(in: .whitespaces)
  return found.flatMap { FileManager.default.isExecutableFile(atPath: $0) ? $0 : nil }
}

func haveToken() -> Bool {
  run("/usr/bin/security", ["find-generic-password", "-s", keychainItem]).status == 0
}

/// The tunnel id in a whole tunnel token (base64 of {"a": account, "t": tunnel, "s": secret}),
/// or nil for a cut-off or mistyped one.
func tunnelId(_ token: String) -> String? {
  var b64 = token
  while b64.count % 4 != 0 { b64 += "=" }
  guard let data = Data(base64Encoded: b64),
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    json["a"] is String, json["s"] is String, let t = json["t"] as? String
  else { return nil }
  return t
}

/// A separate cloudflared service would connect the Mac to WMac a second time; the old
/// LaunchAgent would run a second relay. Both are background items this app replaces.
func otherServices() -> [String] {
  let home = NSHomeDirectory()
  return [
    "/Library/LaunchDaemons/com.cloudflare.cloudflared.plist",
    "\(home)/Library/LaunchAgents/com.cloudflare.cloudflared.plist",
    "/Library/LaunchDaemons/homebrew.mxcl.cloudflared.plist",
    "\(home)/Library/LaunchAgents/homebrew.mxcl.cloudflared.plist",
    "\(home)/Library/LaunchAgents/local.cf-tunnel-relay.plist",
  ].filter { FileManager.default.fileExists(atPath: $0) }
}

/// The body of a 200 from a loopback URL, or nil; never waits more than two seconds.
func get(_ url: String) -> String? {
  let request = URLRequest(
    url: URL(string: url)!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
  var body: String?
  let done = DispatchSemaphore(value: 0)
  URLSession.shared.dataTask(with: request) { data, response, _ in
    if let data = data, (response as? HTTPURLResponse)?.statusCode == 200 {
      body = String(decoding: data, as: UTF8.self)
    }
    done.signal()
  }.resume()
  done.wait()
  return body
}

func relayAnswers() -> Bool { get("http://127.0.0.1:8811/health") == "ok" }

/// cloudflared's own count of its live connections to Cloudflare.
func connections() -> Int {
  for line in (get("http://127.0.0.1:8812/metrics") ?? "").split(separator: "\n")
  where line.hasPrefix("cloudflared_tunnel_ha_connections ") {
    return Int(Double(line.split(separator: " ").last ?? "") ?? 0)
  }
  return 0
}

final class Controller: NSObject, NSApplicationDelegate, NSMenuDelegate {
  var item: NSStatusItem!
  let status = NSMenuItem(title: "Checking…", action: nil, keyEquivalent: "")
  let toggle = NSMenuItem(title: "Tunnel on", action: #selector(Controller.flip), keyEquivalent: "")
  let restart = NSMenuItem(
    title: "Restart relay and cloudflared", action: #selector(Controller.restartRelay), keyEquivalent: "")
  let atLogin = NSMenuItem(title: "Open at Login", action: #selector(Controller.flipLogin), keyEquivalent: "")

  let defaults = UserDefaults.standard
  /// What the switch is set to; kept, so the app comes back the way it was left.
  var wantOn: Bool {
    get { defaults.object(forKey: "on") as? Bool ?? true }
    set { defaults.set(newValue, forKey: "on") }
  }
  var child: Process?
  var lifeline: Pipe?
  var startedAt = Date()
  var retryDelay: TimeInterval = 5
  var retryPending = false
  var quitting = false

  func applicationDidFinishLaunching(_ note: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    menu.delegate = self
    menu.autoenablesItems = false
    status.isEnabled = false
    let log = NSMenuItem(title: "Show error log", action: #selector(showLog), keyEquivalent: "")
    let domains = NSMenuItem(title: "Allowed domains…", action: #selector(editDomains), keyEquivalent: "")
    let token = NSMenuItem(title: "Replace tunnel token…", action: #selector(replaceToken), keyEquivalent: "")
    for i in [toggle, restart, atLogin, log, domains, token] { i.target = self }
    menu.addItem(status)
    menu.addItem(.separator())
    menu.addItem(toggle)
    menu.addItem(restart)
    menu.addItem(.separator())
    menu.addItem(domains)
    menu.addItem(token)
    menu.addItem(atLogin)
    menu.addItem(log)
    menu.addItem(.separator())
    menu.addItem(
      NSMenuItem(
        title: "Quit (stops relay and cloudflared)",
        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    item.menu = menu

    // The first time it runs, it puts itself in Open at Login, which is what it is for; after
    // that, the menu item (or System Settings) decides.
    if #available(macOS 13, *), defaults.object(forKey: "loginItemSet") == nil {
      defaults.set(true, forKey: "loginItemSet")
      try? SMAppService.mainApp.register()
    }

    draw(nil)
    let others = otherServices()
    if !others.isEmpty {
      complain(
        "These start a cloudflared or a relay of their own, alongside this app:\n\n"
          + others.joined(separator: "\n")
          + "\n\nRemove them with `sudo cloudflared service uninstall`, `brew services stop "
          + "cloudflared`, or for local.cf-tunnel-relay: `launchctl bootout "
          + "gui/$(id -u)/local.cf-tunnel-relay` and delete the file.")
    }
    if wantOn { start() }
    Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
  }

  func menuWillOpen(_ menu: NSMenu) { refresh() }

  // MARK: the relay

  func start() {
    guard child == nil, !quitting else { return }
    guard let script = config["Script"], FileManager.default.fileExists(atPath: script) else {
      wantOn = false
      draw(nil)
      return complain(
        "The relay is not at \(config["Script"] ?? "(no path)") any more. Run "
          + "`sh scripts/build-cf-tunnel-relay-app.sh` from the clone of mcp-tools to build the app "
          + "again.")
    }
    guard let node = locate("Node", "node"), let cloudflared = locate("Cloudflared", "cloudflared")
    else {
      wantOn = false
      draw(nil)
      return complain(
        "Node or cloudflared cannot be found. Install them (Node 18 or later; `brew install "
          + "cloudflared`, the program only, no service) and turn the tunnel on again.")
    }
    if !haveToken() && !askToken() {
      wantOn = false
      return draw(nil)
    }
    // Something else answering on 8811 (an old LaunchAgent, or the relay run by hand) would mean
    // a second cloudflared for WMac, and a relay this app cannot stop.
    DispatchQueue.global().async {
      let taken = relayAnswers()
      DispatchQueue.main.async {
        guard self.child == nil, self.wantOn, !self.quitting else { return }
        if taken {
          self.wantOn = false
          self.draw(nil)
          return self.complain(
            "Something else is already answering on 127.0.0.1:8811, so the relay was not started. "
              + "`lsof -i :8811` shows what. An old LaunchAgent goes with "
              + "`launchctl bootout gui/$(id -u)/local.cf-tunnel-relay`.")
        }
        self.launch(node: node, script: script, cloudflared: cloudflared)
      }
    }
  }

  func launch(node: String, script: String, cloudflared: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [script]
    var env = ProcessInfo.processInfo.environment
    for key in relaySettings {
      env[key] = nil
      if let v = defaults.string(forKey: key), !v.isEmpty { env[key] = v }
    }
    env["CF_TUNNEL_RELAY_CLOUDFLARED"] = cloudflared
    env["CF_TUNNEL_RELAY_LIFELINE"] = "1"
    p.environment = env
    let pipe = Pipe()
    p.standardInput = pipe
    p.standardOutput = FileHandle.nullDevice
    // Errors only, as before; normal output is dropped, so nothing on disk lists the URLs fetched.
    if !FileManager.default.fileExists(atPath: errLog) {
      FileManager.default.createFile(atPath: errLog, contents: nil)
    }
    if let err = FileHandle(forWritingAtPath: errLog) {
      err.seekToEndOfFile()
      p.standardError = err
    }
    p.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async { self?.ended(proc) }
    }
    do {
      try p.run()
      child = p
      lifeline = pipe
      startedAt = Date()
    } catch {
      complain("Could not run \(node) \(script):\n\(error.localizedDescription)")
      wantOn = false
    }
    draw(nil)
  }

  /// The relay has gone. Started again while the switch is on, after 5 seconds, doubling up to a
  /// minute while it keeps failing, as launchd's KeepAlive used to.
  func ended(_ p: Process) {
    if child === p {
      child = nil
      lifeline = nil
    }
    draw(nil)
    if quitting { return NSApp.reply(toApplicationShouldTerminate: true) }
    guard wantOn, !retryPending else { return }
    if Date().timeIntervalSince(startedAt) > 60 { retryDelay = 5 }
    let wait = retryDelay
    retryDelay = min(retryDelay * 2, 60)
    retryPending = true
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
      self.retryPending = false
      if self.wantOn { self.start() }
    }
  }

  /// Asks the relay to stop (it stops cloudflared first), and makes sure after five seconds.
  func stop() {
    guard let p = child else { return }
    p.terminate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
      if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }
  }

  // MARK: the menu

  @objc func flip() {
    wantOn = !wantOn
    retryDelay = 5
    if wantOn { start() } else { stop() }
    draw(nil)
  }

  @objc func restartRelay() {
    retryDelay = 5
    // ended() starts it again, since the switch is still on.
    if child != nil { stop() } else { start() }
    draw(nil)
  }

  @objc func flipLogin() {
    guard #available(macOS 13, *) else { return }
    do {
      if SMAppService.mainApp.status == .enabled {
        try SMAppService.mainApp.unregister()
      } else {
        try SMAppService.mainApp.register()
      }
    } catch {
      complain(
        "Could not change Open at Login: \(error.localizedDescription)\n\nSystem Settings -> "
          + "General -> Login Items does the same.")
    }
    draw(nil)
  }

  /// Asks for the tunnel token and keeps it in the Keychain; false if none was stored.
  @discardableResult
  func askToken() -> Bool {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "Tunnel token for WMac"
    alert.informativeText =
      "In the Cloudflare dashboard: Networking -> Tunnels -> WMac -> Add a replica. Copy the "
      + "install command and paste only its long eyJ… part. It goes into your login Keychain as "
      + "the item \(keychainItem), and nowhere else."
    let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
    alert.accessoryView = field
    alert.addButton(withTitle: "Save")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = field
    guard alert.runModal() == .alertFirstButtonReturn else { return false }
    let token = field.stringValue.components(separatedBy: .whitespacesAndNewlines).joined()
    guard tunnelId(token) != nil else {
      complain(
        "That is not a whole tunnel token (\(token.count) characters, where one is about 180): "
          + "nothing was stored.")
      return false
    }
    // Through security's standard input, so the token is never on a command line where ps shows it.
    run(
      "/usr/bin/security", ["-i"],
      input: "add-generic-password -U -s \(keychainItem) -a \(NSUserName()) -l \(keychainItem) "
        + "-w \(token)\n")
    let stored = run("/usr/bin/security", ["find-generic-password", "-s", keychainItem, "-w"])
    guard stored.output.trimmingCharacters(in: .whitespacesAndNewlines) == token else {
      complain("The Keychain item \(keychainItem) does not hold the token just pasted.")
      return false
    }
    return true
  }

  @objc func replaceToken() {
    // The relay reads the token each time it starts cloudflared; a restart picks the new one up.
    if askToken() && child != nil { restartRelay() }
  }

  @objc func editDomains() {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "Allowed domains"
    alert.informativeText = "Comma-separated, such as example.org, abc.net.au; each also covers "
      + "its subdomains. Saving restarts the relay."
    // Laid out by hand: an alert's accessory view gets the size it is given, and a stack view
    // given a frame lays its fields out at zero height.
    let rows = [
      ("ALLOW_DOMAINS", "Only fetch these (empty: any public domain)"),
      ("BROWSER_ALLOW_DOMAINS", "Browser mode may load these (empty: browser mode off)"),
    ]
    let box = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 104))
    var fields: [NSTextField] = []
    for (i, (key, caption)) in rows.enumerated() {
      let top = 104 - CGFloat(i) * 54
      let label = NSTextField(labelWithString: caption)
      label.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
      label.frame = NSRect(x: 0, y: top - 18, width: 360, height: 16)
      let field = NSTextField(frame: NSRect(x: 0, y: top - 44, width: 360, height: 24))
      field.placeholderString = "none"
      field.stringValue = defaults.string(forKey: key) ?? ""
      box.addSubview(label)
      box.addSubview(field)
      fields.append(field)
    }
    alert.accessoryView = box
    alert.window.initialFirstResponder = fields[0]
    alert.addButton(withTitle: "Save")
    alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    for (key, f) in zip(["ALLOW_DOMAINS", "BROWSER_ALLOW_DOMAINS"], fields) {
      defaults.set(f.stringValue.replacingOccurrences(of: " ", with: ""), forKey: key)
    }
    if child != nil { restartRelay() }
  }

  @objc func showLog() {
    if !FileManager.default.fileExists(atPath: errLog) {
      return complain("Nothing has been written to \(errLog) yet.")
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-a", "Console", errLog]
    try? p.run()
  }

  func refresh() {
    guard child != nil else { return draw(nil) }
    DispatchQueue.global().async {
      let up = relayAnswers()
      let n = up ? connections() : 0
      DispatchQueue.main.async { self.draw((up, n)) }
    }
  }

  /// probe: whether /health answered and how many connections cloudflared has, when known.
  func draw(_ probe: (relay: Bool, connections: Int)?) {
    let symbol: String
    if !wantOn {
      symbol = "icloud.slash"
      status.title = child == nil ? "Off: relay and cloudflared stopped" : "Turning off…"
    } else if child == nil {
      symbol = "exclamationmark.icloud"
      status.title = "On: relay stopped, starting it again shortly (see the error log)"
    } else if let probe = probe, probe.relay, probe.connections > 0 {
      symbol = "cloud.fill"
      let n = probe.connections
      status.title = "On: connected to WMac (\(n) connection\(n == 1 ? "" : "s"))"
    } else if let probe = probe, probe.relay {
      symbol = "exclamationmark.icloud"
      status.title = "On: relay up, cloudflared not connected yet"
    } else {
      symbol = "exclamationmark.icloud"
      status.title = "On: relay starting…"
    }
    toggle.state = wantOn ? .on : .off
    restart.isEnabled = wantOn
    if #available(macOS 13, *) {
      atLogin.state = SMAppService.mainApp.status == .enabled ? .on : .off
    } else {
      atLogin.isHidden = true
    }
    if let button = item?.button {
      if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: status.title) {
        image.isTemplate = true
        button.image = image
        button.title = ""
      } else {
        button.image = nil
        button.title = wantOn ? "WMac" : "WMac off"
      }
      button.toolTip = "CF Tunnel Relay — \(status.title)"
    }
  }

  func complain(_ message: String) {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "CF Tunnel Relay"
    alert.informativeText = message
    alert.runModal()
  }

  // MARK: quitting

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard child != nil else { return .terminateNow }
    quitting = true
    stop()
    // ended() replies once the relay has gone.
    return .terminateLater
  }
}

/// The app icon, drawn rather than kept as a file: a white cloud on a blue tile, at every size an
/// .iconset needs. The build runs `CFTunnelRelay --write-iconset <dir>` and hands it to iconutil.
func writeIconset(to dir: String) -> Bool {
  guard #available(macOS 12, *) else { return false }
  let sizes: [(String, Int)] = [
    ("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
    ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512),
    ("512x512@2x", 1024),
  ]
  try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  for (name, px) in sizes {
    guard
      let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0)
    else { return false }
    let s = CGFloat(px)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    // The proportions of macOS's own icons: a tile 80% of the canvas, corners at 18%.
    let tile = NSBezierPath(
      roundedRect: NSRect(x: s * 0.1, y: s * 0.1, width: s * 0.8, height: s * 0.8),
      xRadius: s * 0.18, yRadius: s * 0.18)
    NSGradient(
      starting: NSColor(srgbRed: 0.33, green: 0.62, blue: 1.0, alpha: 1),
      ending: NSColor(srgbRed: 0.16, green: 0.30, blue: 0.80, alpha: 1))?.draw(in: tile, angle: -90)
    let look = NSImage.SymbolConfiguration(pointSize: s * 0.36, weight: .regular)
      .applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
    if let cloud = NSImage(systemSymbolName: "cloud.fill", accessibilityDescription: nil)?
      .withSymbolConfiguration(look)
    {
      let size = cloud.size
      cloud.draw(
        in: NSRect(
          x: (s - size.width) / 2, y: (s - size.height) / 2, width: size.width,
          height: size.height))
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]),
      (try? png.write(to: URL(fileURLWithPath: "\(dir)/icon_\(name).png"))) != nil
    else { return false }
  }
  return true
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--write-iconset" {
  exit(writeIconset(to: CommandLine.arguments[2]) ? 0 : 1)
}

let app = NSApplication.shared
let controller = Controller()
app.delegate = controller
// A menu bar item only: no Dock icon, no app menu (LSUIElement says the same in Info.plist).
app.setActivationPolicy(.accessory)
app.run()
