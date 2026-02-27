/** Persists quota history and UI state in VS Code's globalState. */
import * as vscode from 'vscode';

export interface HistoryPoint {
    timestamp: number;
    usage: Record<string, number>;
}

const HISTORY_KEY = 'agm.quotaHistory';
const MAX_HISTORY_HOURS = 168; // 7 days

export class StorageService {
    private history: HistoryPoint[] = [];
    private globalState: vscode.Memento;

    constructor(globalState: vscode.Memento) {
        this.globalState = globalState;
        this.load();
    }

    async recordQuotaPoint(usage: Record<string, number>): Promise<void> {
        this.history.push({ timestamp: Date.now(), usage });
        await this.save();
    }

    getRecentHistory(minutes: number): HistoryPoint[] {
        const cutoff = Date.now() - minutes * 60 * 1000;
        return this.history.filter(p => p.timestamp > cutoff);
    }

    calculateUsageBuckets(rangeMinutes: number, intervalMinutes: number): UsageBucket[] {
        const now = Date.now();
        const start = now - rangeMinutes * 60 * 1000;
        const buckets: UsageBucket[] = [];
        const numBuckets = Math.ceil(rangeMinutes / intervalMinutes);
        const allPoints = this.getRecentHistory(rangeMinutes + intervalMinutes);
        const groupIds = new Set<string>();
        allPoints.forEach(p => Object.keys(p.usage).forEach(k => groupIds.add(k)));

        for (let i = 0; i < numBuckets; i++) {
            const bucketStart = start + i * intervalMinutes * 60 * 1000;
            const bucketEnd = Math.min(bucketStart + intervalMinutes * 60 * 1000, now);
            const bucket: UsageBucket = { startTime: bucketStart, endTime: bucketEnd, items: [] };

            const inBucket = allPoints.filter(p => p.timestamp >= bucketStart && p.timestamp < bucketEnd);
            const before = allPoints.filter(p => p.timestamp < bucketStart);

            let first: HistoryPoint | null = null;
            let last: HistoryPoint | null = null;

            if (before.length > 0) {
                first = before[before.length - 1];
                last = inBucket.length > 0 ? inBucket[inBucket.length - 1] : null;
            } else if (inBucket.length >= 2) {
                first = inBucket[0];
                last = inBucket[inBucket.length - 1];
            }

            if (first && last) {
                for (const gid of groupIds) {
                    const valBefore = first.usage[gid] ?? 0;
                    const valAfter = last.usage[gid] ?? 0;
                    if (first.usage[gid] !== undefined && last.usage[gid] !== undefined) {
                        const diff = Math.max(0, valBefore - valAfter);
                        if (diff > 0) bucket.items.push({ groupId: gid, usage: diff });
                    }
                }
            }
            buckets.push(bucket);
        }
        return buckets;
    }

    // Snapshot
    getLastSnapshot(): any | null {
        const stored = this.globalState.get<{ data: any; timestamp: number }>('agm.lastSnapshot');
        if (!stored) return null;
        const cutoff = Date.now() - MAX_HISTORY_HOURS * 60 * 60 * 1000;
        return stored.timestamp < cutoff ? null : stored.data;
    }

    async setLastSnapshot(data: any): Promise<void> {
        await this.globalState.update('agm.lastSnapshot', { data, timestamp: Date.now() });
    }

    // Display percentage
    getLastDisplayPercentage(): number { return this.globalState.get('agm.lastDisplayPct', 0); }
    async setLastDisplayPercentage(val: number): Promise<void> { await this.globalState.update('agm.lastDisplayPct', val); }

    // Cache size
    getLastCacheSize(): number { return this.globalState.get('agm.lastCacheSize', 0); }
    async setLastCacheSize(val: number): Promise<void> { await this.globalState.update('agm.lastCacheSize', val); }

    // Cache warning
    getLastCacheWarningTime(): number { return this.globalState.get('agm.lastCacheWarnTime', 0); }
    async setLastCacheWarningTime(val: number): Promise<void> { await this.globalState.update('agm.lastCacheWarnTime', val); }

    // User info
    getLastUserInfo(): any | null { return this.globalState.get('agm.lastUserInfo', null); }
    async setLastUserInfo(data: any): Promise<void> { await this.globalState.update('agm.lastUserInfo', data); }

    // Token usage
    getLastTokenUsage(): any | null { return this.globalState.get('agm.lastTokenUsage', null); }
    async setLastTokenUsage(data: any): Promise<void> { await this.globalState.update('agm.lastTokenUsage', data); }

    // Session consumption — diff between first and latest recorded point
    getSessionConsumption(): { prompt: number; flow: number; total: number } {
        if (this.history.length < 2) return { prompt: 0, flow: 0, total: 0 };
        const first = this.history[0];
        const last = this.history[this.history.length - 1];
        const promptDiff = Math.max(0, (first.usage['prompt'] ?? 0) - (last.usage['prompt'] ?? 0));
        const flowDiff = Math.max(0, (first.usage['flow'] ?? 0) - (last.usage['flow'] ?? 0));
        return { prompt: promptDiff, flow: flowDiff, total: promptDiff + flowDiff };
    }

    private load(): void {
        const stored = this.globalState.get<HistoryPoint[]>(HISTORY_KEY);
        if (stored && Array.isArray(stored)) {
            const cutoff = Date.now() - MAX_HISTORY_HOURS * 60 * 60 * 1000;
            this.history = stored.filter(p => p.timestamp > cutoff);
        }
    }

    private async save(): Promise<void> {
        const cutoff = Date.now() - MAX_HISTORY_HOURS * 60 * 60 * 1000;
        this.history = this.history.filter(p => p.timestamp > cutoff);
        await this.globalState.update(HISTORY_KEY, this.history);
    }
}

export interface UsageBucket {
    startTime: number;
    endTime: number;
    items: { groupId: string; usage: number }[];
}
