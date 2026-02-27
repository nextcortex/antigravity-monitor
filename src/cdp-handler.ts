/**
 * Cross-platform auto-clicker for Antigravity IDE.
 *
 * Windows: Spawns a PowerShell child process that uses .NET's
 *   System.Windows.Automation to find and click Accept/Run buttons.
 *
 * macOS/Linux: Uses CDP (Chrome DevTools Protocol) over WebSocket.
 *   Requires Antigravity to be launched with --remote-debugging-port=9000.
 *   If CDP is unavailable, shows a one-time user notification.
 *
 * All connections are strictly local (127.0.0.1); no external network calls.
 */
import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import WebSocket from 'ws';
import { logInfo, logDebug, logWarn } from './logger';

// ── Browser script injected via CDP (macOS/Linux) ────────────────────────────

const DEFAULT_ACCEPT_KW = ['accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'allow'];
const DEFAULT_REJECT_KW = ['skip', 'reject', 'cancel', 'close', 'refine', 'always', 'agm:'];

function buildBrowserScript(acceptKw: string[], rejectKw: string[]): string {
    const acceptJson = JSON.stringify(acceptKw);
    const rejectJson = JSON.stringify(rejectKw);
    return `(function() {
    if (typeof window === 'undefined') return;
    // Always overwrite to pick up keyword changes
    var accept = ${acceptJson};
    var reject = ${rejectJson};

    function isAcceptButton(el) {
        var text = (el.textContent || '').trim().toLowerCase();
        if (text.length === 0 || text.length > 50) return false;
        if (reject.some(function(r) { return text.includes(r); })) return false;
        if (!accept.some(function(p) { return text.includes(p); })) return false;
        var style = window.getComputedStyle(el);
        var rect = el.getBoundingClientRect();
        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && style.pointerEvents !== 'none'
            && !el.disabled;
    }

    function queryDeep(node, selector, results) {
        results = results || [];
        if (!node) return results;
        if (node.querySelectorAll) {
            try { results.push.apply(results, Array.from(node.querySelectorAll(selector))); } catch(e) {}
        }
        var children = node.children || node.childNodes || [];
        for (var i = 0; i < children.length; i++) queryDeep(children[i], selector, results);
        if (node.shadowRoot) queryDeep(node.shadowRoot, selector, results);
        return results;
    }

    window.__agmAutoAcceptTargets = function() {
        var selectors = ['.bg-ide-button-background', 'button', '[class*="button"]', '[role="button"]'];
        var found = [];
        selectors.forEach(function(s) { queryDeep(document, s, found); });
        var seen = new Set();
        var targets = [];
        for (var i = 0; i < found.length; i++) {
            var el = found[i];
            if (seen.has(el)) continue;
            seen.add(el);
            if (isAcceptButton(el)) {
                var rect = el.getBoundingClientRect();
                var y = Math.round(rect.top + rect.height / 2);
                if (y < 45) continue;
                targets.push({
                    x: Math.round(rect.left + rect.width / 2),
                    y: y,
                    text: el.textContent.trim()
                });
            }
        }
        return targets;
    };
})();`;
}

// ── Unified auto-clicker ─────────────────────────────────────────────────────

export class CDPAutoClicker {
    private _running = false;
    private _totalClicks = 0;
    private _acceptKeywords: string[] = [...DEFAULT_ACCEPT_KW];
    private _rejectKeywords: string[] = [...DEFAULT_REJECT_KW];
    private _browserScript: string = buildBrowserScript(DEFAULT_ACCEPT_KW, DEFAULT_REJECT_KW);

    // UIA (Windows)
    private _uiaWorker: ChildProcess | undefined;

    // CDP (macOS/Linux)
    private _cdpConnections = new Map<string, { ws: WebSocket; injected: boolean }>();
    private _cdpPollTimer: ReturnType<typeof setInterval> | undefined;
    private _cdpMsgId = 1;
    private _cdpNotified = false;

    private static readonly CDP_BASE_PORT = 9000;
    private static readonly CDP_RANGE = 4;

    /** Update accept/reject keywords and regenerate browser script */
    updateKeywords(accept: string[], reject: string[]): void {
        this._acceptKeywords = [...accept];
        this._rejectKeywords = [...reject];
        this._browserScript = buildBrowserScript(this._acceptKeywords, this._rejectKeywords);
        // Re-inject into all active CDP connections
        if (this._running) {
            for (const [id, conn] of this._cdpConnections) {
                if (conn.injected) {
                    this.cdpEvaluate(id, this._browserScript).catch(() => { });
                }
            }
        }
        logInfo(`CDP keywords updated (${this._acceptKeywords.length} accept, ${this._rejectKeywords.length} reject)`);
        // Write config for UIA worker on Windows
        if (os.platform() === 'win32') {
            this.writeUiaConfig();
        }
    }

    getAcceptKeywords(): string[] { return [...this._acceptKeywords]; }
    getRejectKeywords(): string[] { return [...this._rejectKeywords]; }

    async start(): Promise<void> {
        if (this._running) return;
        this._running = true;
        this._totalClicks = 0;

        if (os.platform() === 'win32') {
            this.writeUiaConfig(); // Write config BEFORE spawning worker
            this.startUIA();
        } else {
            await this.startCDP();
        }
    }

    async stop(): Promise<void> {
        if (!this._running) return;
        this._running = false;

        if (os.platform() === 'win32') {
            this.stopUIA();
        } else {
            this.stopCDP();
        }

        logInfo(`Auto-clicker stopped (${this._totalClicks} clicks total)`);
    }

    isRunning(): boolean { return this._running; }

    dispose(): void { this.stop(); }

    /** Write UIA keyword config so PowerShell worker can read it */
    private writeUiaConfig(): void {
        try {
            const cfgPath = path.join(os.tmpdir(), 'agm-uia-config.json');
            // Convert simple keywords into regex patterns for UIA
            const acceptPatterns = this._acceptKeywords.map(kw => `^${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
            const skipPatterns = this._rejectKeywords.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            fs.writeFileSync(cfgPath, JSON.stringify({ acceptPatterns, skipPatterns }, null, 2), 'utf8');
            logDebug(`UIA config written to ${cfgPath}`);
        } catch {
            // Non-critical — UIA will use defaults
        }
    }

    // ── Windows UIA ──────────────────────────────────────────────────────────

    private startUIA(): void {
        const scriptPath = path.join(__dirname, 'uia-worker.ps1');
        logDebug(`Spawning UIA worker: ${scriptPath}`);

        try {
            this._uiaWorker = spawn('powershell', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
            ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

            this._uiaWorker.stdout?.on('data', (data: Buffer) => {
                for (const line of data.toString().split('\n')) {
                    const t = line.trim();
                    if (t.startsWith('CLICK:')) {
                        this._totalClicks++;
                        logInfo(`UIA auto-clicked: "${t.substring(6)}" (total: ${this._totalClicks})`);
                    } else if (t === 'UIA-READY') {
                        logInfo('UIA auto-clicker ready');
                    }
                }
            });

            this._uiaWorker.stderr?.on('data', (data: Buffer) => {
                logDebug(`UIA stderr: ${data.toString().trim()}`);
            });

            this._uiaWorker.on('error', (err) => {
                logWarn(`UIA worker error: ${err.message}`);
                this._uiaWorker = undefined;
            });

            this._uiaWorker.on('close', (code) => {
                logDebug(`UIA worker exited (code ${code})`);
                this._uiaWorker = undefined;
            });

            logInfo(`UIA auto-clicker started (PID ${this._uiaWorker.pid})`);
        } catch (err: any) {
            logWarn(`Failed to start UIA worker: ${err.message}`);
        }
    }

    private stopUIA(): void {
        if (this._uiaWorker) {
            try { this._uiaWorker.kill(); } catch { /* already dead */ }
            this._uiaWorker = undefined;
        }
    }

    // ── macOS/Linux CDP ──────────────────────────────────────────────────────

    private async startCDP(): Promise<void> {
        const found = await this.cdpScanAndConnect();

        if (!found && !this._cdpNotified) {
            this._cdpNotified = true;
            const msg = 'Auto-clicker: CDP not available. Launch Antigravity with: antigravity --remote-debugging-port=9000';
            logWarn(msg);
            vscode.window.showWarningMessage(msg);
            return;
        }

        this._cdpPollTimer = setInterval(() => this.cdpPollAndClick(), 500);
        logInfo(`CDP auto-clicker started (${this._cdpConnections.size} page(s))`);
    }

    private stopCDP(): void {
        if (this._cdpPollTimer) {
            clearInterval(this._cdpPollTimer);
            this._cdpPollTimer = undefined;
        }
        for (const [, conn] of this._cdpConnections) {
            try { conn.ws.close(); } catch { /* ignore */ }
        }
        this._cdpConnections.clear();
    }

    private async cdpScanAndConnect(): Promise<boolean> {
        let found = false;
        const base = CDPAutoClicker.CDP_BASE_PORT;
        const range = CDPAutoClicker.CDP_RANGE;

        for (let port = base - range; port <= base + range; port++) {
            try {
                const pages = await this.cdpGetPages(port);
                for (const page of pages) {
                    const id = `${port}:${page.id}`;
                    if (!this._cdpConnections.has(id)) {
                        const ok = await this.cdpConnect(id, page.webSocketDebuggerUrl);
                        if (ok) {
                            await this.cdpEvaluate(id, this._browserScript);
                            const c = this._cdpConnections.get(id);
                            if (c) c.injected = true;
                            found = true;
                        }
                    }
                }
            } catch { /* port not available */ }
        }
        return found;
    }

    private async cdpPollAndClick(): Promise<void> {
        if (!this._running) return;
        if (this._cdpConnections.size === 0) {
            await this.cdpScanAndConnect();
            return;
        }

        for (const [id] of this._cdpConnections) {
            try {
                const res = await this.cdpEvaluate(
                    id, 'JSON.stringify(window.__agmAutoAcceptTargets ? window.__agmAutoAcceptTargets() : [])'
                );
                if (!res?.result?.value) continue;
                const targets: { x: number; y: number; text: string }[] = JSON.parse(res.result.value);

                for (const t of targets) {
                    logDebug(`CDP clicking "${t.text}" at (${t.x}, ${t.y})`);
                    await this.cdpSend(id, 'Input.dispatchMouseEvent', {
                        type: 'mousePressed', button: 'left', clickCount: 1, x: t.x, y: t.y,
                    });
                    await sleep(50);
                    await this.cdpSend(id, 'Input.dispatchMouseEvent', {
                        type: 'mouseReleased', button: 'left', clickCount: 1, x: t.x, y: t.y,
                    });
                    this._totalClicks++;
                    logInfo(`CDP auto-clicked: "${t.text}" (total: ${this._totalClicks})`);
                }
            } catch {
                this._cdpConnections.delete(id);
            }
        }
    }

    private cdpGetPages(port: number): Promise<any[]> {
        return new Promise((resolve) => {
            const req = http.get(
                { hostname: '127.0.0.1', port, path: '/json/list', timeout: 800 },
                (res) => {
                    let body = '';
                    res.on('data', (c) => (body += c));
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(body).filter((p: any) => {
                                if (!p.webSocketDebuggerUrl) return false;
                                if (p.type !== 'page' && p.type !== 'webview') return false;
                                const u = (p.url || '').toLowerCase();
                                return !u.startsWith('devtools://') && !u.startsWith('chrome-devtools://');
                            }));
                        } catch { resolve([]); }
                    });
                }
            );
            req.on('error', () => resolve([]));
            req.on('timeout', () => { req.destroy(); resolve([]); });
        });
    }

    private cdpConnect(id: string, url: string): Promise<boolean> {
        return new Promise((resolve) => {
            const ws = new WebSocket(url);
            ws.on('open', () => { this._cdpConnections.set(id, { ws, injected: false }); resolve(true); });
            ws.on('error', () => resolve(false));
            ws.on('close', () => { this._cdpConnections.delete(id); });
        });
    }

    private cdpSend(id: string, method: string, params: any = {}): Promise<any> {
        const conn = this._cdpConnections.get(id);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) return Promise.resolve(undefined);
        return new Promise((resolve, reject) => {
            const mid = this._cdpMsgId++;
            const timer = setTimeout(() => reject(new Error('CDP timeout')), 2000);
            const handler = (data: WebSocket.Data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id === mid) {
                        conn.ws.off('message', handler);
                        clearTimeout(timer);
                        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
                    }
                } catch { /* malformed */ }
            };
            conn.ws.on('message', handler);
            conn.ws.send(JSON.stringify({ id: mid, method, params }));
        });
    }

    private cdpEvaluate(id: string, expr: string): Promise<any> {
        return this.cdpSend(id, 'Runtime.evaluate', { expression: expr, userGesture: true, awaitPromise: true });
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
