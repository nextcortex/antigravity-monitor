import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | null = null;
let debugEnabled = false;

export function initLogger(ctx: vscode.ExtensionContext): vscode.OutputChannel {
    outputChannel = vscode.window.createOutputChannel('Antigravity Monitor');
    ctx.subscriptions.push(outputChannel);
    return outputChannel;
}

export function getOutputChannel(): vscode.OutputChannel | null {
    return outputChannel;
}

export function setDebugMode(enabled: boolean): void {
    debugEnabled = enabled;
}

function ts(): string {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
}

export function logDebug(msg: string, data?: unknown): void {
    if (!debugEnabled || !outputChannel) return;
    outputChannel.appendLine(`[${ts()}] ${msg}`);
    if (data !== undefined) {
        outputChannel.appendLine(typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data));
    }
}

export function logInfo(msg: string): void {
    if (!outputChannel) return;
    outputChannel.appendLine(`[${ts()}] ℹ️ ${msg}`);
}

export function logWarn(msg: string): void {
    if (!outputChannel) return;
    outputChannel.appendLine(`[${ts()}] ⚠️ ${msg}`);
}

export function logError(msg: string, err?: unknown): void {
    if (!outputChannel) return;
    outputChannel.appendLine(`[${ts()}] ❌ ${msg}`);
    if (err) {
        if (err instanceof Error) {
            outputChannel.appendLine(`  ${err.message}`);
            if (err.stack) outputChannel.appendLine(`  ${err.stack}`);
        } else {
            outputChannel.appendLine(`  ${String(err)}`);
        }
    }
}
