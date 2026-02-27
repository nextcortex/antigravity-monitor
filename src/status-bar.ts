/** Status bar — renders quota indicators with rich Markdown tooltips. */
import * as vscode from 'vscode';
import { formatSize } from './cache-manager';
import { QuotaSnapshot, ModelQuota } from './quota-fetcher';
import { getGroupForModel, getModelDisplayName, MODEL_GROUPS } from './model-groups';
import { ConfigManager } from './config';

export class StatusBarManager {
    private item: vscode.StatusBarItem;

    constructor(private configManager: ConfigManager) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'agm.showQuickPick';
    }

    showLoading(): void {
        this.item.text = '$(sync~spin) AGM';
        this.item.tooltip = 'Antigravity Monitor — Detecting server…';
        this.item.backgroundColor = undefined;
        this.item.show();
    }

    showError(msg: string): void {
        this.item.text = '$(warning) AGM';
        this.item.tooltip = `Antigravity Monitor — ${msg}`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.item.show();
    }

    update(snapshot: QuotaSnapshot | null, cacheSize: number): void {
        const cfg = this.configManager.getConfig();
        if (!cfg['status.showQuota'] && !cfg['status.showCache']) {
            this.item.hide();
            return;
        }

        if (!snapshot || snapshot.models.length === 0) {
            this.item.text = '$(rocket) AGM';
            this.item.tooltip = 'Antigravity Monitor — No data yet';
            this.item.backgroundColor = undefined;
            this.item.show();
            return;
        }

        const warnThreshold = cfg['status.warningThreshold'];
        const critThreshold = cfg['status.criticalThreshold'];
        const scope = cfg['status.scope'];
        const format = cfg['status.displayFormat'];

        // Group models by family
        const grouped = this.groupModels(snapshot.models);

        // ── Status Bar Text ──
        const parts: string[] = [];
        if (cfg['status.showQuota']) {
            // Find the worst-off group for the primary indicator
            const worst = grouped.reduce((a, b) => a.remaining < b.remaining ? a : b);
            const worstEmoji = this.emoji(worst.remaining, warnThreshold, critThreshold);

            if (scope === 'all') {
                // Compact format: show all groups inline
                const groupParts = grouped.map(g => {
                    const e = this.emoji(g.remaining, warnThreshold, critThreshold);
                    return `${e}${g.shortLabel} ${Math.round(g.remaining)}%`;
                });
                parts.push(`$(pulse) ${groupParts.join('  ')}`);
            } else {
                // Primary only
                parts.push(`$(pulse) ${worstEmoji}${this.formatDisplay(worst, format)}`);
            }
        }

        if (cfg['status.showCache'] && cacheSize > 0) {
            parts.push(`$(database) ${formatSize(cacheSize)}`);
        }

        this.item.text = parts.length > 0 ? parts.join('  ') : '$(check) AGM';

        // ── Tooltip — Rich Markdown ──
        const md = new vscode.MarkdownString('', true);
        md.isTrusted = true;
        md.supportHtml = true;

        // Header
        md.appendMarkdown(`### 🛡️ Antigravity Monitor\n\n`);
        md.appendMarkdown(`---\n\n`);

        // Per-group quota rows
        for (const g of grouped) {
            const pct = Math.round(g.remaining);
            const emoji = this.emoji(g.remaining, warnThreshold, critThreshold);
            const bar = this.progressBar(pct, warnThreshold, critThreshold);

            md.appendMarkdown(`**${emoji} ${g.label}**\n\n`);
            md.appendMarkdown(`\`${bar}\` **${pct}%** &nbsp; ⏱ ${g.resetTime}\n\n`);
        }

        // Individual models breakdown
        if (snapshot.models.length > grouped.length) {
            md.appendMarkdown(`---\n\n`);
            md.appendMarkdown(`**📋 Models**\n\n`);
            for (const model of snapshot.models) {
                const displayName = getModelDisplayName(model.modelId, model.label);
                const pct = model.timeUntilReset === 'Ready' ? 100 : Math.round(model.remainingPct);
                const emoji = this.emoji(pct, warnThreshold, critThreshold);
                md.appendMarkdown(`${emoji} \`${displayName}\` — ${pct}% ⏱ ${model.timeUntilReset}\n\n`);
            }
        }

        // Cache
        if (cfg['status.showCache'] && cacheSize > 0) {
            md.appendMarkdown(`---\n\n`);
            md.appendMarkdown(`💾 **Cache** &nbsp; ${formatSize(cacheSize)}\n\n`);
        }

        // User info
        if (snapshot.userInfo) {
            md.appendMarkdown(`---\n\n`);
            const name = snapshot.userInfo.name || 'User';
            const tier = snapshot.userInfo.tier || snapshot.userInfo.planName || '';
            md.appendMarkdown(`👤 **${name}** &nbsp; ${tier}\n\n`);
        }

        // Credits
        if (snapshot.tokenUsage) {
            if (snapshot.tokenUsage.promptCredits) {
                const pc = snapshot.tokenUsage.promptCredits;
                md.appendMarkdown(`💳 Prompt: **${Math.round(pc.remainingPct)}%** (${this.fmtNum(pc.available)}/${this.fmtNum(pc.monthly)})\n\n`);
            }
            if (snapshot.tokenUsage.flowCredits) {
                const fc = snapshot.tokenUsage.flowCredits;
                md.appendMarkdown(`⚡ Flow: **${Math.round(fc.remainingPct)}%** (${this.fmtNum(fc.available)}/${this.fmtNum(fc.monthly)})\n\n`);
            }
        }

        // Footer
        md.appendMarkdown(`---\n\n`);
        md.appendMarkdown(`🔒 *100% Local — Click to open panel*`);

        this.item.tooltip = md;
        this.item.backgroundColor = undefined;
        this.item.show();
    }

    dispose(): void {
        this.item.dispose();
    }

    private emoji(pct: number, warn: number, crit: number): string {
        if (pct <= crit) return '🔴';
        if (pct <= warn) return '🟡';
        return '🟢';
    }

    private progressBar(pct: number, warn: number, crit: number): string {
        const total = 16;
        const clamped = Math.max(0, Math.min(100, pct));
        const filled = Math.round((clamped / 100) * total);
        const empty = total - filled;
        const fillChar = pct <= crit ? '▓' : pct <= warn ? '▓' : '█';
        return fillChar.repeat(filled) + '░'.repeat(empty);
    }

    private fmtNum(n: number): string {
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return n.toString();
    }

    private formatDisplay(g: { shortLabel: string; remaining: number; resetTime: string; resetDate?: Date }, format: string): string {
        switch (format) {
            case 'resetTime': return `${g.shortLabel} ${g.resetTime}`;
            case 'resetTimestamp':
                if (g.resetDate) {
                    const now = new Date();
                    const isToday = now.getDate() === g.resetDate.getDate() && now.getMonth() === g.resetDate.getMonth();
                    const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(g.resetDate);
                    if (isToday) return `${g.shortLabel} ${time}`;
                    const date = new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit' }).format(g.resetDate);
                    return `${g.shortLabel} ${date} ${time}`;
                }
                return `${g.shortLabel} ${g.resetTime}`;
            case 'used': return `${g.shortLabel} ${100 - Math.round(g.remaining)}/100`;
            case 'remaining': return `${g.shortLabel} ${Math.round(g.remaining)}/100`;
            default: return `${g.shortLabel} ${Math.round(g.remaining)}%`;
        }
    }

    private groupModels(models: ModelQuota[]): GroupedQuota[] {
        const map = new Map<string, ModelQuota[]>();
        for (const m of models) {
            const g = getGroupForModel(m.modelId, m.label);
            const list = map.get(g.id) || [];
            list.push(m);
            map.set(g.id, list);
        }
        const result: GroupedQuota[] = [];
        for (const g of MODEL_GROUPS) {
            const members = map.get(g.id);
            if (!members || members.length === 0) continue;
            const worst = members.reduce((a, b) => a.remainingPct < b.remainingPct ? a : b);
            result.push({
                id: g.id,
                label: g.label,
                shortLabel: g.shortLabel,
                remaining: worst.timeUntilReset === 'Ready' ? 100 : worst.remainingPct,
                resetTime: worst.timeUntilReset,
                resetDate: worst.resetTime,
                themeColor: g.themeColor,
            });
        }
        return result;
    }
}

interface GroupedQuota {
    id: string;
    label: string;
    shortLabel: string;
    remaining: number;
    resetTime: string;
    resetDate?: Date;
    themeColor: string;
}
