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

// Default Antigravity IDE internal accept commands
const DEFAULT_ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.terminalCommand.accept',
    'antigravity.command.accept',
    'antigravity.acceptCompletion',
    'antigravity.prioritized.agentAcceptAllInFile',
    'antigravity.prioritized.agentAcceptFocusedHunk',
    'antigravity.prioritized.supercompleteAccept',
    'antigravity.prioritized.terminalSuggestion.accept',
];

// All known auto-execution settings with their "on" values
export const ALL_AUTO_SETTINGS: { key: string; onValue: any }[] = [
    { key: 'antigravity.agent.terminal.autoExecutionPolicy', onValue: 'always' },
    { key: 'antigravity.agent.terminal.confirmCommands', onValue: false },
    { key: 'antigravity.agent.terminal.allowedCommands', onValue: ['*'] },
    { key: 'antigravity.terminal.autoRun', onValue: true },
    { key: 'cortex.agent.autoRun', onValue: true },
    { key: 'geminicodeassist.agentYoloMode', onValue: true },
    { key: 'gemini.cli.yoloMode', onValue: true },
];

// Gemini CLI settings file
const GEMINI_CLI_SETTINGS = path.join(os.homedir(), '.gemini', 'settings.json');

export interface AutoAcceptConfig {
    commands: string[];
    enabledSettings: string[];
    acceptKeywords: string[];
    rejectKeywords: string[];
}

export class AutoAcceptService {
    private _enabled = false;
    private _timer: ReturnType<typeof setInterval> | undefined;
    private _interval: number;
    private _tickCount = 0;
    private _savedSettings = new Map<string, any>();
    private _previousCliApproval: string | undefined;
    private _cdp = new CDPAutoClicker();
    private _commands: string[];
    private _enabledSettings: string[];

    constructor(interval: number = 800, config?: AutoAcceptConfig) {
        this._interval = Math.max(200, interval);
        this._commands = config?.commands ?? [...DEFAULT_ACCEPT_COMMANDS];
        this._enabledSettings = config?.enabledSettings ?? ALL_AUTO_SETTINGS.map(s => s.key);
        if (config?.acceptKeywords || config?.rejectKeywords) {
            this._cdp.updateKeywords(
                config?.acceptKeywords ?? ['accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'allow'],
                config?.rejectKeywords ?? ['skip', 'reject', 'cancel', 'close', 'refine', 'always', 'agm:']
            );
        }
    }

    start(): void {
        if (this._enabled) return;
        this._enabled = true;
        this._tickCount = 0;
        this._timer = setInterval(() => this.tick(), this._interval);
        this.enableAutoSettings();
        this._cdp.start();
        logInfo(`Auto-accept enabled (interval: ${this._interval}ms, ${this._commands.length} commands)`);
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

    /** Update the accept commands list at runtime */
    updateCommands(cmds: string[]): void {
        this._commands = [...cmds];
        logInfo(`Auto-accept commands updated (${this._commands.length} commands)`);
    }

    /** Update which auto-execution settings are enabled */
    updateEnabledSettings(keys: string[]): void {
        this._enabledSettings = keys;
        logInfo(`Auto-accept settings updated (${this._enabledSettings.length} enabled)`);
    }

    /** Update CDP accept/reject keywords */
    updateKeywords(accept: string[], reject: string[]): void {
        this._cdp.updateKeywords(accept, reject);
        logInfo(`Auto-accept keywords updated (${accept.length} accept, ${reject.length} reject)`);
    }

    /** Get current configuration for sidebar display */
    getConfig(): AutoAcceptConfig {
        return {
            commands: [...this._commands],
            enabledSettings: [...this._enabledSettings],
            acceptKeywords: this._cdp.getAcceptKeywords(),
            rejectKeywords: this._cdp.getRejectKeywords(),
        };
    }

    dispose(): void {
        this.stop();
        this._cdp.dispose();
    }

    // Save current values, then apply auto-accept settings
    private enableAutoSettings(): void {
        const cfg = vscode.workspace.getConfiguration();
        let applied = 0;

        // Only apply settings that are in the enabled list
        // Skip virtual keys (handled separately, e.g. gemini.cli.yoloMode → file-based)
        const activeSettings = ALL_AUTO_SETTINGS.filter(
            s => this._enabledSettings.includes(s.key) && !s.key.startsWith('gemini.cli.')
        );

        for (const { key, onValue } of activeSettings) {
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
        // Gemini CLI yolo: only if the virtual setting key is in the enabled list
        if (this._enabledSettings.includes('gemini.cli.yoloMode')) {
            this.enableGeminiCliYolo();
        }
    }

    // Restore all settings to their pre-auto-accept values
    private restoreAutoSettings(): void {
        const cfg = vscode.workspace.getConfiguration();
        let restored = 0;

        for (const [key, saved] of this._savedSettings) {
            try {
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
        // Only restore Gemini CLI if we actually enabled it
        if (this._enabledSettings.includes('gemini.cli.yoloMode')) {
            this.restoreGeminiCliYolo();
        }
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

        for (const cmd of this._commands) {
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
