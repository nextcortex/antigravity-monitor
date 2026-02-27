/**
 * Process finder — detects the Antigravity language_server process,
 * extracts its CSRF token, and discovers the API port.
 * All connections are strictly local (127.0.0.1).
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import * as https from 'https';
import * as process from 'process';
import * as vscode from 'vscode';
import { logDebug, logInfo, logWarn, logError } from './logger';

const execAsync = promisify(exec);

export interface ServerInfo {
    port: number;
    csrfToken: string;
}

interface ProcessCandidate {
    pid: number;
    extensionPort: number;
    csrfToken: string;
    workspaceId?: string;
}

export async function findAntigravityProcess(workspacePath?: string): Promise<ServerInfo | null> {
    const processName = getProcessName();
    try {
        logDebug(`Looking for process: ${processName}`);
        const candidates = await findProcessCandidates(processName, workspacePath);
        if (!candidates || candidates.length === 0) {
            logWarn('No Antigravity language server process found');
            return null;
        }

        // Try workspace-matched candidate first
        if (workspacePath) {
            const wsId = toWorkspaceId(workspacePath);
            const matched = candidates.find(c => c.workspaceId === wsId);
            if (matched) {
                const result = await tryCandidate(matched);
                if (result) return result;
            }
        }

        // Try all candidates
        for (const candidate of candidates) {
            const result = await tryCandidate(candidate);
            if (result) return result;
        }
        return null;
    } catch {
        return null;
    }
}

async function tryCandidate(candidate: ProcessCandidate): Promise<ServerInfo | null> {
    if (!candidate.csrfToken) return null;
    const ports = await getListeningPorts(candidate.pid);
    if (candidate.extensionPort > 0 && !ports.includes(candidate.extensionPort)) {
        ports.unshift(candidate.extensionPort);
    }
    if (ports.length === 0) return null;
    const workingPort = await findWorkingPort(ports, candidate.csrfToken);
    if (!workingPort) return null;
    logInfo(`Connected to language server on port ${workingPort}`);
    return { port: workingPort, csrfToken: candidate.csrfToken };
}

function getProcessName(): string {
    if (process.platform === 'win32') return 'language_server_windows_x64.exe';
    if (process.platform === 'darwin') return `language_server_macos${process.arch === 'arm64' ? '_arm' : ''}`;
    return `language_server_linux${process.arch === 'arm64' ? '_arm' : '_x64'}`;
}

function toWorkspaceId(folderPath: string): string {
    if (process.platform === 'win32') {
        const match = folderPath.match(/^([A-Za-z]):(.*)/);
        if (match) {
            const drive = match[1].toLowerCase();
            const rest = match[2].split(/[\\/]/).filter(s => s.length > 0)
                .map(s => encodeURIComponent(s)).join('_').replace(/[^a-zA-Z0-9]/g, '_');
            return `file_${drive}_3A_${rest}`;
        }
    }
    return 'file_' + folderPath.replace(/\\/g, '/').split('/').map(s => encodeURIComponent(s))
        .join('/').replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '').replace(/[^a-zA-Z0-9]/g, '_');
}

async function findProcessCandidates(name: string, workspacePath?: string): Promise<ProcessCandidate[] | null> {
    const cmd = process.platform === 'win32'
        ? `chcp 65001 >nul && powershell -ExecutionPolicy Bypass -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $f = 'name=''${name}'''; $p = Get-CimInstance Win32_Process -Filter $f -ErrorAction SilentlyContinue; if ($p) { @($p) | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress } else { '[]' }"`
        : process.platform === 'darwin'
            ? `pgrep -fl ${name}`
            : `pgrep -af ${name}`;

    try {
        const { stdout } = await execAsync(cmd, { timeout: 15000 });
        return parseProcessOutput(stdout, workspacePath);
    } catch {
        // Try keyword fallback
        try {
            const fallbackCmd = process.platform === 'win32'
                ? `chcp 65001 >nul && powershell -ExecutionPolicy Bypass -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'csrf_token' } -ErrorAction SilentlyContinue; if ($p) { @($p) | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress } else { '[]' }"`
                : `ps -A -ww -o pid,ppid,args | grep "csrf_token" | grep -v grep`;
            const { stdout } = await execAsync(fallbackCmd, { timeout: 15000 });
            return parseProcessOutput(stdout, workspacePath);
        } catch {
            return null;
        }
    }
}

function parseProcessOutput(stdout: string, _workspacePath?: string): ProcessCandidate[] | null {
    if (process.platform === 'win32') {
        return parseWindows(stdout);
    }
    return parseUnix(stdout);
}

function parseWindows(stdout: string): ProcessCandidate[] | null {
    try {
        const trimmed = stdout.trim();
        const start = trimmed.indexOf('[') !== -1 && (trimmed.indexOf('{') === -1 || trimmed.indexOf('[') < trimmed.indexOf('{'))
            ? trimmed.indexOf('[') : trimmed.indexOf('{');
        if (start === -1) return null;
        let data = JSON.parse(trimmed.substring(start));
        if (!Array.isArray(data)) data = [data];
        const results: ProcessCandidate[] = [];
        for (const entry of data) {
            const cmdLine = entry.CommandLine || '';
            const pid = entry.ProcessId;
            if (!pid) continue;
            // Only match Antigravity processes
            if (!cmdLine.includes('--csrf_token')) continue;
            if (!cmdLine.includes('--app_data_dir') || !/app_data_dir\s+["']?antigravity/i.test(cmdLine)) continue;
            const port = cmdLine.match(/--extension_server_port[=\s]+(\d+)/);
            const token = cmdLine.match(/--csrf_token[=\s]+(?:["']?)([a-zA-Z0-9\-_.]+)(?:["']?)/);
            const ws = cmdLine.match(/--workspace_id[=\s]+(?:["']?)([a-zA-Z0-9\-_.]+)(?:["']?)/);
            if (token?.[1]) {
                results.push({
                    pid,
                    extensionPort: port ? parseInt(port[1], 10) : 0,
                    csrfToken: token[1],
                    workspaceId: ws?.[1],
                });
            }
        }
        return results.length > 0 ? results : null;
    } catch {
        return null;
    }
}

function parseUnix(stdout: string): ProcessCandidate[] | null {
    const lines = stdout.split('\n').filter(l => l.includes('--extension_server_port'));
    const results: ProcessCandidate[] = [];
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        const cmd = line.substring(parts[0].length).trim();
        if (!cmd.includes('--csrf_token')) continue;
        if (!cmd.includes('--app_data_dir') || !/app_data_dir\s+["']?antigravity/i.test(cmd)) continue;
        const port = cmd.match(/--extension_server_port[=\s]+(\d+)/);
        const token = cmd.match(/--csrf_token[=\s]+([a-zA-Z0-9\-_.]+)/);
        const ws = cmd.match(/--workspace_id[=\s]+(?:["']?)([a-zA-Z0-9\-_.]+)(?:["']?)/);
        if (token?.[1]) {
            results.push({
                pid,
                extensionPort: port ? parseInt(port[1], 10) : 0,
                csrfToken: token[1],
                workspaceId: ws?.[1],
            });
        }
    }
    return results.length > 0 ? results : null;
}

async function getListeningPorts(pid: number): Promise<number[]> {
    if (!Number.isInteger(pid) || pid <= 0) return [];
    try {
        const cmd = process.platform === 'darwin'
            ? `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`
            : process.platform === 'win32'
                ? `chcp 65001 >nul && powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $p = Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort; if ($p) { $p | Sort-Object -Unique }"`
                : `ss -tlnp 2>/dev/null | grep "pid=${pid}" || lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null`;
        const { stdout } = await execAsync(cmd, { timeout: 8000 });
        return parsePortOutput(stdout, pid);
    } catch {
        return [];
    }
}

function parsePortOutput(stdout: string, pid: number): number[] {
    const ports: number[] = [];
    if (process.platform === 'win32') {
        for (const line of stdout.trim().split(/\r?\n/)) {
            const n = parseInt(line.trim(), 10);
            if (n > 0 && n <= 65535 && !ports.includes(n)) ports.push(n);
        }
    } else if (process.platform === 'darwin') {
        const regex = new RegExp(`^\\S+\\s+${pid}\\s+.*?(?:TCP|UDP)\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]+\\]):(\\d+)\\s+\\(LISTEN\\)`, 'gim');
        let match;
        while ((match = regex.exec(stdout)) !== null) {
            const p = parseInt(match[1], 10);
            if (!ports.includes(p)) ports.push(p);
        }
    } else {
        // Linux — parse ss/lsof
        const listenRegex = /LISTEN\s+\d+\s+\d+\s+(?:\*|[\d.]+|\[[\da-f:]*\]):(\d+)/gi;
        let match;
        while ((match = listenRegex.exec(stdout)) !== null) {
            const p = parseInt(match[1], 10);
            if (!ports.includes(p)) ports.push(p);
        }
        if (ports.length === 0) {
            const lsofRegex = new RegExp(`^\\S+\\s+${pid}\\s+.*?(?:TCP|UDP)\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]+\\]):(\\d+)\\s+\\(LISTEN\\)`, 'gim');
            while ((match = lsofRegex.exec(stdout)) !== null) {
                const p = parseInt(match[1], 10);
                if (!ports.includes(p)) ports.push(p);
            }
        }
    }
    return ports.sort((a, b) => a - b);
}

async function findWorkingPort(ports: number[], csrfToken: string): Promise<number | null> {
    for (const port of ports) {
        if (await testPort(port, csrfToken)) return port;
    }
    return null;
}

async function testPort(port: number, csrfToken: string): Promise<boolean> {
    // Try HTTP first, then HTTPS — both on 127.0.0.1 only
    if (await testPortWithProtocol(port, csrfToken, 'http')) return true;
    return testPortWithProtocol(port, csrfToken, 'https');
}

function testPortWithProtocol(port: number, csrfToken: string, protocol: 'http' | 'https'): Promise<boolean> {
    return new Promise(resolve => {
        const lib = protocol === 'https' ? https : http;
        const req = lib.request({
            hostname: '127.0.0.1',
            port,
            path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Codeium-Csrf-Token': csrfToken,
                'Connect-Protocol-Version': '1',
            },
            rejectUnauthorized: false,
            timeout: 3000,
        }, res => {
            let body = '';
            res.on('data', (chunk: Buffer) => (body += chunk));
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try { JSON.parse(body); resolve(true); } catch { resolve(false); }
                } else {
                    resolve(false);
                }
            });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write(JSON.stringify({ wrapper_data: {} }));
        req.end();
    });
}
