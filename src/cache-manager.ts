/** Cache manager — reads, sizes, and cleans Antigravity IDE local cache dirs. */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface BrainTask {
    id: string;
    label: string;
    path: string;
    size: number;
    fileCount: number;
    createdAt: number;
}

export interface CodeContext {
    id: string;
    name: string;
    size: number;
}

export interface CacheInfo {
    brainSize: number;
    conversationsSize: number;
    totalSize: number;
    brainCount: number;
    conversationsCount: number;
    brainTasks: BrainTask[];
    codeContexts: CodeContext[];
}

export interface FileEntry {
    name: string;
    path: string;
}

function getGeminiDir(): string { return path.join(os.homedir(), '.gemini'); }
function getAntigravityDir(): string { return path.join(getGeminiDir(), 'antigravity'); }
export function getBrainDir(): string { return path.join(getAntigravityDir(), 'brain'); }
export function getConversationsDir(): string { return path.join(getAntigravityDir(), 'conversations'); }
export function getCodeTrackerDir(): string { return path.join(getAntigravityDir(), 'code_tracker', 'active'); }
export function getRulesPath(): string { return path.join(getGeminiDir(), 'GEMINI.md'); }
export function getMcpConfigPath(): string { return path.join(getAntigravityDir(), 'mcp_config.json'); }
export function getBrowserAllowlistPath(): string { return path.join(getAntigravityDir(), 'browserAllowlist.txt'); }

export class CacheManager {
    private brainDir: string;
    private conversationsDir: string;
    private codeTrackerDir: string;

    constructor(brainDir?: string, conversationsDir?: string, codeTrackerDir?: string) {
        this.brainDir = brainDir || getBrainDir();
        this.conversationsDir = conversationsDir || getConversationsDir();
        this.codeTrackerDir = codeTrackerDir || getCodeTrackerDir();
    }

    async getCacheInfo(): Promise<CacheInfo> {
        const [brainSize, conversationsSize, brainTasks, codeContexts, conversationsCount] = await Promise.all([
            this.getDirectorySize(this.brainDir),
            this.getDirectorySize(this.conversationsDir),
            this.getBrainTasks(),
            this.getCodeContexts(),
            this.getFileCount(this.conversationsDir),
        ]);
        return {
            brainSize,
            conversationsSize,
            totalSize: brainSize + conversationsSize,
            brainCount: brainTasks.length,
            conversationsCount,
            brainTasks,
            codeContexts,
        };
    }

    async getBrainTasks(): Promise<BrainTask[]> {
        try {
            const entries = await fs.promises.readdir(this.brainDir, { withFileTypes: true });
            const tasks: BrainTask[] = [];
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const taskPath = path.join(this.brainDir, entry.name);
                const [size, fileCount, label, stat] = await Promise.all([
                    this.getDirectorySize(taskPath),
                    this.getFileCount(taskPath),
                    this.getTaskLabel(taskPath, entry.name),
                    fs.promises.stat(taskPath),
                ]);
                tasks.push({
                    id: entry.name,
                    label,
                    path: taskPath,
                    size,
                    fileCount,
                    createdAt: stat.birthtimeMs || stat.mtimeMs,
                });
            }
            return tasks.sort((a, b) => b.createdAt - a.createdAt);
        } catch {
            return [];
        }
    }

    async getCodeContexts(): Promise<CodeContext[]> {
        try {
            const entries = await fs.promises.readdir(this.codeTrackerDir, { withFileTypes: true });
            const contexts: CodeContext[] = [];
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const ctxPath = path.join(this.codeTrackerDir, entry.name);
                const size = await this.getDirectorySize(ctxPath);
                contexts.push({ id: entry.name, name: entry.name, size });
            }
            return contexts.sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            return [];
        }
    }

    async getTaskFiles(taskId: string): Promise<FileEntry[]> {
        return this.getFilesInDirectory(path.join(this.brainDir, taskId));
    }

    async getContextFiles(contextId: string): Promise<FileEntry[]> {
        return this.getFilesInDirectory(path.join(this.codeTrackerDir, contextId));
    }

    async deleteTask(taskId: string): Promise<void> {
        if (!this.isSafeId(taskId)) return;
        const taskPath = path.join(this.brainDir, taskId);
        await fs.promises.rm(taskPath, { recursive: true, force: true });
        const convPath = path.join(this.conversationsDir, `${taskId}.pb`);
        await fs.promises.rm(convPath, { force: true }).catch(() => { });
    }

    async deleteContext(contextId: string): Promise<void> {
        if (!this.isSafeId(contextId)) return;
        const ctxPath = path.join(this.codeTrackerDir, contextId);
        await fs.promises.rm(ctxPath, { recursive: true, force: true });
    }

    private isSafeId(id: string): boolean {
        if (!id || id.length > 200) return false;
        if (/[\/\\]/.test(id) || id.includes('..') || path.isAbsolute(id)) return false;
        return /^[a-zA-Z0-9\-_.]+$/.test(id);
    }

    async deleteFile(filePath: string): Promise<void> {
        await fs.promises.rm(filePath, { force: true });
    }

    async cleanCache(keepCount: number = 5): Promise<{ deletedCount: number; freedBytes: number }> {
        try {
            let deletedCount = 0;
            let freedBytes = 0;
            const tasks = await this.getBrainTasks();
            if (tasks.length > keepCount) {
                const toDelete = tasks.slice(keepCount);
                for (const task of toDelete) {
                    freedBytes += task.size;
                    await this.deleteTask(task.id);
                    deletedCount++;
                }
            }
            return { deletedCount, freedBytes };
        } catch {
            return { deletedCount: 0, freedBytes: 0 };
        }
    }

    getBrainDirPath(): string { return this.brainDir; }

    private async getDirectorySize(dirPath: string): Promise<number> {
        try {
            const stat = await fs.promises.stat(dirPath);
            if (!stat.isDirectory()) return stat.size;
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            let total = 0;
            for (const entry of entries) {
                const entryPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) total += await this.getDirectorySize(entryPath);
                else if (entry.isFile()) {
                    const s = await fs.promises.stat(entryPath);
                    total += s.size;
                }
            }
            return total;
        } catch {
            return 0;
        }
    }

    private async getFileCount(dirPath: string): Promise<number> {
        try {
            return (await fs.promises.readdir(dirPath, { withFileTypes: true })).filter(e => e.isFile()).length;
        } catch {
            return 0;
        }
    }

    private async getTaskLabel(taskPath: string, id: string): Promise<string> {
        try {
            const mdPath = path.join(taskPath, 'task.md');
            const content = await fs.promises.readFile(mdPath, 'utf-8');
            const firstLine = content.split('\n')[0];
            if (firstLine?.startsWith('#')) return firstLine.replace(/^#+\s*/, '').trim();
            return content.trim().split('\n')[0] || id;
        } catch {
            return id;
        }
    }

    private async getFilesInDirectory(dirPath: string): Promise<FileEntry[]> {
        try {
            return (await fs.promises.readdir(dirPath, { withFileTypes: true }))
                .filter(e => e.isFile())
                .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }));
        } catch {
            return [];
        }
    }
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let val = bytes / 1024;
    let idx = 0;
    while (val >= 1024 && idx < units.length - 1) { val /= 1024; idx++; }
    return `${val.toFixed(1)} ${units[idx]}`;
}
