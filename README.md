# Antigravity Monitor

<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-0078d4?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-43a047?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/platform-Windows%20·%20macOS%20·%20Linux-8957e5?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/engine-vscode%20≥%201.90-007acc?style=flat-square" alt="Engine">
  <img src="https://img.shields.io/badge/telemetry-none-e53935?style=flat-square" alt="Telemetry">
</p>

<p align="center">
  <a href="https://nextcortex.github.io/"><img src="https://img.shields.io/badge/🌐_Website-nextcortex.github.io-blue?style=for-the-badge" alt="Website"></a>
  <a href="https://nextcortex.github.io/donate.html"><img src="https://img.shields.io/badge/💖_Donate-Support_NextCortex-ff69b4?style=for-the-badge" alt="Donate"></a>
</p>

**100% local & secure** quota monitor for Antigravity IDE with real-time dashboard, usage analytics, cache management, and intelligent auto-accept.

> **Zero network calls. Zero telemetry. Everything stays on your machine.**

<p align="center">
  <img src="https://raw.githubusercontent.com/nextcortex/antigravity-monitor/main/assets/nextcortex_antigravity-monitor.png" alt="Antigravity Monitor">
</p>

---

## Features

### 📊 Real-Time Quota Dashboard

- Live circular gauge showing remaining credits vs. daily limit
- Credit breakdown by model group (Pro, Flash, Balanced, Legacy)
- Color-coded usage indicators (green → yellow → red)
- Auto-refresh every 90 seconds or manual refresh on-demand

### 📈 Usage History

- SVG sparkline showing credits remaining over time
- Separate lines for Prompt (blue) and Flow (purple) credits
- Session consumption summary with credits used
- Smart flat-line detection — shows values when no changes occur

### 🚀 Intelligent Auto-Accept

Three-layer system for fully hands-free agent operation:

| Layer | Method | What it does |
|---|---|---|
| **Commands** | 8 VS Code commands (800ms polling) | Accepts agent steps, terminal commands, completions |
| **Settings** | Gemini yolo mode + auto-execution policies | Configures persistent approval settings |
| **UI Automation** | Native OS automation | Clicks "Run"/"Accept" buttons automatically |

**Platform-specific behavior:**

| Platform | Auto-clicker method | Requirements |
|---|---|---|
| **Windows** | Native UI Automation (PowerShell) | None — works out of the box |
| **macOS** | CDP via WebSocket | Launch with `--remote-debugging-port=9000` |
| **Linux** | CDP via WebSocket | Launch with `--remote-debugging-port=9000` |

### 💾 Cache Manager

- View cache size and entry count at a glance
- One-click cache clear
- Automatic cache invalidation on data changes

### 🔒 Security First

- **Local-only** — All communication restricted to `127.0.0.1`
- **No telemetry** — Zero external network calls, ever
- **CSP nonce** — Webview content secured against injection attacks
- **Input sanitization** — All user inputs validated and escaped
- **No data leaves your machine** — Quota reads from local language server only

---

## 💿 Installation

### From GitHub Releases

1. Download the latest `.vsix` from the **Releases** page
2. In Antigravity/VS Code: `Extensions` → `...` → `Install from VSIX...`
3. Restart the editor

### From Open VSX / Marketplace

1. Open the Extensions view (`Ctrl+Shift+X`)
2. Search for **"Antigravity Monitor"**
3. Click **Install**

### From Command Line

```bash
antigravity --install-extension nextcortex-antigravity-monitor-*.vsix --force
```

### Build from Source

```bash
git clone https://github.com/nextcortex/antigravity-monitor.git
cd antigravity-monitor
npm install
npm run build
npx @vscode/vsce package --no-dependencies
antigravity --install-extension antigravity-monitor-*.vsix --force
```

---

## ⚡ Quick Start

1. **Install** the extension (see above)
2. **Reload** the editor — `Ctrl+Shift+P` → `Developer: Reload Window`
3. Look for the **Antigravity Monitor** icon in the Activity Bar (left sidebar)
4. Click it to open the dashboard
5. *(Optional)* Enable **Auto-Accept** from the sidebar toggle

### Auto-Accept: Windows

Works immediately. Toggle Auto-Accept **ON** in the sidebar. The extension spawns a background PowerShell process that uses Windows UI Automation to find and click Accept/Run buttons natively. No additional setup required.

### Auto-Accept: macOS / Linux

Launch Antigravity with the Chrome DevTools Protocol flag:

```bash
antigravity --remote-debugging-port=9000
```

Then toggle Auto-Accept **ON**. The extension connects via WebSocket to the renderer and clicks Accept/Run buttons using CDP mouse events. If the flag is missing, you'll see a one-time warning with instructions.

---

## ⚙️ Configuration

All settings are under the `agm.*` namespace:

| Setting | Type | Default | Description |
|---|---|---|---|
| `agm.dashboard.refreshRate` | `number` | `90` | Quota poll interval in seconds (min: 30) |
| `agm.dashboard.historyRange` | `number` | `90` | Usage history range in minutes |
| `agm.dashboard.gaugeStyle` | `string` | `semi-arc` | Gauge display style |
| `agm.system.autoAccept` | `boolean` | `false` | Enable auto-accept on startup |
| `agm.system.autoAcceptInterval` | `number` | `800` | Auto-accept tick interval in ms (min: 200) |

---

## 🎯 Commands

Open the Command Palette (`Ctrl+Shift+P`) and type `Antigravity Monitor`:

| Command | Description |
|---|---|
| `Antigravity Monitor: Toggle Auto-Accept` | Enable or disable auto-accept |
| `Antigravity Monitor: Refresh Quota` | Force an immediate quota refresh |
| `Antigravity Monitor: Clear Cache` | Clear all cached quota data |

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────┐
│             Antigravity Monitor               │
├──────────┬───────────┬───────────────────────┤
│  Quota   │  Cache    │    Auto-Accept        │
│  Fetcher │  Manager  │    Service            │
│          │           │    ├── VS Code Cmds   │
├──────────┴───────────┤    ├── Settings API   │
│  Process Finder      │    └── UIA / CDP      │
│  (127.0.0.1 only)    │        Clicker        │
├──────────────────────┴───────────────────────┤
│  Sidebar Webview (CSP + Nonce secured)       │
├──────────────────────────────────────────────┤
│  Status Bar · Logger · Config Manager        │
└──────────────────────────────────────────────┘
```

---

## 🛡️ Privacy

This extension is designed with privacy as a core principle:

- ✅ All communication is **local-only** (`127.0.0.1`)
- ✅ Quota data is read from the **local Antigravity language server**
- ✅ Cache is stored in VS Code's **local `globalState`**
- ❌ No analytics
- ❌ No tracking
- ❌ No telemetry
- ❌ No external API calls
- ❌ No data collection of any kind

---

## 🔧 Troubleshooting

**Auto-accept is ON but commands still ask for confirmation**

- *Windows*: Check the Output Channel (`Ctrl+Shift+U` → select "Antigravity Monitor") for `UIA auto-clicker ready`. If missing, the PowerShell worker may have failed to start.
- *macOS/Linux*: Ensure Antigravity was launched with `--remote-debugging-port=9000`. Check the Output Channel for `CDP auto-clicker started`.

**Quota shows "No data" or doesn't update**

1. Ensure the Antigravity language server is running (check the status bar)
2. Try `Ctrl+Shift+P` → `Antigravity Monitor: Refresh Quota`
3. Check the Output Channel for connection errors

**Extension doesn't appear in the Activity Bar**

1. Right-click the Activity Bar → ensure "Antigravity Monitor" is checked
2. Try `Ctrl+Shift+P` → `Developer: Reload Window`

---

## 📋 Requirements

| Requirement | Version |
|---|---|
| Antigravity IDE | v1.0+ |
| VS Code Engine | ≥ 1.90.0 |
| Node.js | 18+ (bundled with Antigravity) |
| OS | Windows 10+ · macOS 12+ · Linux (glibc 2.31+) |

---

## Acknowledgments

Inspired by and built upon patterns from:

- [antigravity-pulse](https://open-vsx.org/extension/nicolo/antigravity-pulse) — process finder and quota fetcher architecture
- [Toolkit for Antigravity](https://open-vsx.org/extension/N2NSynthetics/antigravity-panel) by N2N Synthetics — dashboard UI design inspiration

---

## ⚠️ Disclaimer

This project is **not affiliated with, endorsed by, or associated with Google or Antigravity** in any way. It is an independent, community-driven tool created for personal use. Use at your own risk.

---

## 📄 License

This project is licensed under the MIT License. See `LICENSE` for details.

---

<p align="center">
  <img src="https://raw.githubusercontent.com/nextcortex/antigravity-monitor/main/assets/icon.png" alt="Antigravity Monitor Icon" width="128">
</p>
