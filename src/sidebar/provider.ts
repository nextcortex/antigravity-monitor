/** Sidebar webview provider — manages the sidebar panel lifecycle. */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { getRulesPath, getMcpConfigPath, getBrowserAllowlistPath, formatSize } from '../cache-manager';
import { QuotaSnapshot } from '../quota-fetcher';
import { getGroupForModel, MODEL_GROUPS } from '../model-groups';
import { StorageService } from '../storage';
import { ConfigManager } from '../config';
import { ALL_AUTO_SETTINGS } from '../auto-accept';

export interface SidebarState {
    connectionStatus: string;
    quotas: QuotaDisplayItem[];
    chart: ChartData;
    cache: CacheState;
    user?: UserState;
    tokenUsage?: TokenUsageState;
    tasks: TreeSection;
    contexts: TreeSection;
    autoAcceptEnabled: boolean;
    autoAcceptConfig?: AutoAcceptConfigState;
    gaugeStyle: string;
    showUserInfoCard: boolean;
    showCreditsCard: boolean;
    uiScale: number;
}

interface QuotaDisplayItem {
    id: string;
    label: string;
    remaining: number;
    resetTime: string;
    hasData: boolean;
    themeColor: string;
}

interface ChartData {
    points: { t: number; prompt: number; flow: number }[];
    displayMinutes: number;
    sessionConsumption: { prompt: number; flow: number; total: number };
}

interface CacheState {
    totalSize: number;
    brainSize: number;
    conversationsSize: number;
    brainCount: number;
    formattedTotal: string;
    formattedBrain: string;
    formattedConversations: string;
}

interface UserState {
    name?: string;
    email?: string;
    tier?: string;
    planName?: string;
}

interface TokenUsageState {
    promptCredits?: { available: number; monthly: number; remainingPct: number };
    flowCredits?: { available: number; monthly: number; remainingPct: number };
    totalAvailable: number;
    totalMonthly: number;
    overallRemainingPct: number;
}

interface TreeSection {
    expanded: boolean;
    folders: TreeFolder[];
}

interface TreeFolder {
    id: string;
    label: string;
    size: string;
    expanded: boolean;
    files: { name: string; path: string }[];
}

export interface AutoAcceptConfigState {
    commands: string[];
    enabledSettings: string[];
    allSettings: { key: string; label: string }[];
    acceptKeywords: string[];
    rejectKeywords: string[];
    interval: number;
}

export type SidebarMessageHandler = (msg: any) => void;

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'agm.sidebar';
    private _view?: vscode.WebviewView;
    private _messageHandler?: SidebarMessageHandler;

    constructor(
        private _extensionUri: vscode.Uri,
    ) { }

    setMessageHandler(handler: SidebarMessageHandler): void {
        this._messageHandler = handler;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.onDidReceiveMessage(async msg => {
            switch (msg.type) {
                case 'openFile':
                    if (msg.path) {
                        try {
                            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path), { preview: true });
                        } catch {
                            vscode.window.showWarningMessage(`Could not open file: ${msg.path}`);
                        }
                    }
                    return;
                case 'openRules':
                    await this._openOrCreateFile(getRulesPath(), '# Gemini Rules\n\n<!-- Add your custom rules here -->\n');
                    return;
                case 'openMcp':
                    await this._openOrCreateFile(getMcpConfigPath(), '{\n  "mcpServers": {}\n}\n');
                    return;
                case 'openBrowserAllowlist':
                    await this._openOrCreateFile(getBrowserAllowlistPath(), '# Browser Allowlist\n# Add allowed URLs below, one per line\n');
                    return;
                case 'restartLanguageServer':
                    try {
                        await vscode.commands.executeCommand('antigravity.restartLanguageServer');
                        vscode.window.showInformationMessage('✅ Agent service restarted');
                    } catch {
                        vscode.window.showErrorMessage('❌ Failed to restart agent service');
                    }
                    return;
                case 'restartUserStatusUpdater':
                    try {
                        await vscode.commands.executeCommand('antigravity.restartUserStatusUpdater');
                        vscode.window.showInformationMessage('✅ Status updater reset');
                    } catch {
                        vscode.window.showErrorMessage('❌ Failed to reset status updater');
                    }
                    return;
                case 'reloadWindow':
                    await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    return;
                case 'runDiagnostics':
                    await vscode.commands.executeCommand('agm.runDiagnostics');
                    return;
                case 'showLogs':
                    await vscode.commands.executeCommand('agm.showLogs');
                    return;
                case 'openAutoAcceptSource': {
                    const extDir = this._extensionUri.fsPath;
                    const srcFile = path.join(extDir, 'src', 'auto-accept.ts');
                    try {
                        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(srcFile));
                    } catch {
                        vscode.window.showWarningMessage(`Could not open: ${srcFile}`);
                    }
                    return;
                }
                case 'openAutoAcceptResearch': {
                    const extDir2 = this._extensionUri.fsPath;
                    const researchFile = path.join(extDir2, 'AUTOCLICKER_RESEARCH.txt');
                    try {
                        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(researchFile));
                    } catch {
                        vscode.window.showWarningMessage(`Could not open: ${researchFile}`);
                    }
                    return;
                }
                case 'refreshNow':
                    await vscode.commands.executeCommand('agm.refreshQuota');
                    return;
            }
            this._messageHandler?.(msg);
        });

        this._setHtml();
    }

    postUpdate(state: SidebarState): void {
        this._view?.webview.postMessage({ type: 'update', payload: state });
    }

    private async _openOrCreateFile(filePath: string, defaultContent: string): Promise<void> {
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            if (!fs.existsSync(filePath)) {
                fs.writeFileSync(filePath, defaultContent, 'utf-8');
            }
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
        } catch (err) {
            vscode.window.showWarningMessage(`Could not open file: ${filePath}`);
        }
    }

    private _setHtml(): void {
        if (!this._view) return;
        const webview = this._view.webview;
        const nonce = crypto.randomBytes(16).toString('base64');

        const stylesUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js')
        );
        const cspSource = webview.cspSource;

        webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource}; img-src ${cspSource} data:;">
  <link href="${stylesUri}" rel="stylesheet" />
</head>
<body>
  <div id="agm-app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
