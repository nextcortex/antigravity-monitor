# Changelog

All notable changes to **Antigravity Monitor** are documented here.

## [2.0.0] — 2026-02-27

### Added
- **UIA Auto-Clicker (Windows)**: Automatically clicks Accept/Run/Allow buttons using Windows UI Automation — no CDP port required
- **CDP Auto-Clicker (macOS/Linux)**: WebSocket-based auto-clicker for non-Windows platforms via `--remote-debugging-port`
- **Gemini Yolo Mode**: Auto-accept toggle now activates `geminicodeassist.agentYoloMode` and Antigravity terminal auto-execution policy
- **Gemini CLI Integration**: Sets `approval_mode: yolo` in `~/.gemini/settings.json` when auto-accept is enabled
- **Usage History Chart**: Visual 24-hour usage timeline with per-bucket breakdowns
- **Debug Logging**: Extensive debug output in Output Channel for troubleshooting

### Changed
- Sidebar CSS overhauled — removed excessive grays, uses VS Code theme tokens
- Chart empty state shows "Collecting data..." instead of gray dashed line
- Auto-accept now manages 6 VS Code settings + CLI config automatically
- All settings restored to previous values when auto-accept is disabled

### Fixed
- Auto-accept command names updated to correct Antigravity internal commands
- Chart bars with zero usage now render as 1px baseline instead of 2px gray bars
- Text contrast improved in both light and dark themes

### Security
- CSP nonce protection maintained
- All communications restricted to `127.0.0.1`
- Input sanitization verified across all user-facing inputs

---

## [1.0.0] — 2026-02-26

### Added
- Initial release
- Real-time quota gauge with model group breakdown
- Sidebar webview with credit details
- Cache manager with clear functionality
- Auto-accept via VS Code commands
- Status bar integration
- Process finder for local language server
- Extension icon and branding
