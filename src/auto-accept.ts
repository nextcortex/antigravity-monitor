/**
 * Auto-accept — periodically fires all Antigravity accept/approve
 * commands and manages Gemini + Antigravity auto-execution settings
 * for fully hands-free agent operation.
 * Only invokes local VS Code commands and local settings; no network calls.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logInfo, logDebug } from './logger';
import { CDPAutoClicker } from './cdp-handler';

// Antigravity IDE internal accept commands
const ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.terminalCommand.accept',
    'antigravity.command.accept',
    'antigravity.acceptCompletion',
    'antigravity.prioritized.agentAcceptAllInFile',
    'antigravity.prioritized.agentAcceptFocusedHunk',
    'antigravity.prioritized.supercompleteAccept',
    'antigravity.prioritized.terminalSuggestion.accept',
];

// Settings keys that control auto-execution across Antigravity + Gemini
const AUTO_SETTINGS: { key: string; onValue: any }[] = [
    // Antigravity terminal execution policy
    { key: 'antigravity.agent.terminal.autoExecutionPolicy', onValue: 'always' },
    { key: 'antigravity.agent.terminal.confirmCommands', onValue: false },
    { key: 'antigravity.agent.terminal.allowedCommands', onValue: ['*'] },
    { key: 'antigravity.terminal.autoRun', onValue: true },
    { key: 'cortex.agent.autoRun', onValue: true },
    // Gemini Code Assist yolo mode
    { key: 'geminicodeassist.agentYoloMode', onValue: true },
];

// Gemini CLI settings file
const GEMINI_CLI_SETTINGS = path.join(os.homedir(), '.gemini', 'settings.json');

export class AutoAcceptService {
    private _enabled = false;
    private _timer: ReturnType<typeof setInterval> | undefined;
    private _interval: number;
    private _tickCount = 0;
    private _savedSettings = new Map<string, any>();
    private _previousCliApproval: string | undefined;
    private _cdp = new CDPAutoClicker();

    constructor(interval: number = 800) {
        this._interval = Math.max(200, interval);
    }

    start(): void {
        if (this._enabled) return;
        this._enabled = true;
        this._tickCount = 0;
        this._timer = setInterval(() => this.tick(), this._interval);
        this.enableAutoSettings();
        this._cdp.start();
        logInfo(`Auto-accept enabled (interval: ${this._interval}ms)`);
    }

    stop(): void {
        if (!this._enabled) return;
        this._enabled = false;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
        this.restoreAutoSettings();
        this._cdp.stop();
        logInfo(`Auto-accept disabled (ran ${this._tickCount} ticks)`);
        this._tickCount = 0;
    }

    toggle(): boolean {
        if (this._enabled) this.stop();
        else this.start();
        return this._enabled;
    }

    isRunning(): boolean {
        return this._enabled;
    }

    updateInterval(ms: number): void {
        const newInterval = Math.max(200, ms);
        if (newInterval === this._interval) return;
        this._interval = newInterval;
        if (this._enabled) {
            if (this._timer) clearInterval(this._timer);
            this._timer = setInterval(() => this.tick(), this._interval);
            logInfo(`Auto-accept interval updated to ${this._interval}ms`);
        }
    }

    dispose(): void {
        this.stop();
        this._cdp.dispose();
    }

    // Save current values, then apply auto-accept settings
    private enableAutoSettings(): void {
        const cfg = vscode.workspace.getConfiguration();
        let applied = 0;

        for (const { key, onValue } of AUTO_SETTINGS) {
            try {
                const current = cfg.get(key);
                this._savedSettings.set(key, current);
                if (JSON.stringify(current) !== JSON.stringify(onValue)) {
                    cfg.update(key, onValue, vscode.ConfigurationTarget.Global);
                    applied++;
                }
            } catch {
                // Setting not recognized by this IDE — safe to skip
            }
        }

        if (applied > 0) {
            logInfo(`Applied ${applied} auto-execution settings`);
        }

        this.enableGeminiCliYolo();
    }

    // Restore all settings to their pre-auto-accept values
    private restoreAutoSettings(): void {
        const cfg = vscode.workspace.getConfiguration();
        let restored = 0;

        for (const { key } of AUTO_SETTINGS) {
            try {
                const saved = this._savedSettings.get(key);
                // Restore original value; undefined removes the setting
                cfg.update(key, saved, vscode.ConfigurationTarget.Global);
                restored++;
            } catch {
                // Setting not recognized — safe to skip
            }
        }

        this._savedSettings.clear();

        if (restored > 0) {
            logInfo(`Restored ${restored} auto-execution settings`);
        }

        this.restoreGeminiCliYolo();
    }

    // Gemini CLI: toggle approval_mode in ~/.gemini/settings.json
    private enableGeminiCliYolo(): void {
        try {
            const dir = path.dirname(GEMINI_CLI_SETTINGS);
            let settings: Record<string, any> = {};

            if (fs.existsSync(GEMINI_CLI_SETTINGS)) {
                const raw = fs.readFileSync(GEMINI_CLI_SETTINGS, 'utf8');
                settings = JSON.parse(raw);
            } else if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            this._previousCliApproval = settings.approval_mode;

            if (settings.approval_mode !== 'yolo') {
                settings.approval_mode = 'yolo';
                fs.writeFileSync(GEMINI_CLI_SETTINGS, JSON.stringify(settings, null, 2), 'utf8');
                logInfo('Gemini CLI yolo mode enabled');
            }
        } catch {
            logDebug('Could not update Gemini CLI settings (CLI may not be installed)');
        }
    }

    private restoreGeminiCliYolo(): void {
        try {
            if (!fs.existsSync(GEMINI_CLI_SETTINGS)) return;

            const raw = fs.readFileSync(GEMINI_CLI_SETTINGS, 'utf8');
            const settings = JSON.parse(raw);

            if (this._previousCliApproval) {
                settings.approval_mode = this._previousCliApproval;
            } else {
                delete settings.approval_mode;
            }

            fs.writeFileSync(GEMINI_CLI_SETTINGS, JSON.stringify(settings, null, 2), 'utf8');
            logInfo('Gemini CLI approval mode restored');
        } catch {
            // Settings file missing or corrupt — safe to ignore
        }
    }

    private async tick(): Promise<void> {
        if (!this._enabled) return;
        this._tickCount++;

        for (const cmd of ACCEPT_COMMANDS) {
            if (!this._enabled) return;
            try {
                await vscode.commands.executeCommand(cmd);
            } catch {
                // Command not available — expected when no pending accept action
            }
        }
        if (this._tickCount % 10 === 1) {
            logDebug(`Auto-accept tick #${this._tickCount}`);
        }
    }
}
