/**
 * Antigravity Monitor — Main extension entry point.
 * Polls the local language server for quota data and renders it
 * in the status bar, sidebar webview, and QuickPick menu.
 *
 * Architecture: all network I/O targets 127.0.0.1 exclusively.
 * No telemetry, no analytics, no external calls of any kind.
 */
import * as vscode from 'vscode';
import { initLogger, getOutputChannel, setDebugMode, logInfo, logError, logDebug, logWarn } from './logger';
import { ConfigManager } from './config';
import { findAntigravityProcess, ServerInfo } from './process-finder';
import { fetchQuota, QuotaSnapshot } from './quota-fetcher';
import { CacheManager, formatSize } from './cache-manager';
import { StorageService } from './storage';
import { StatusBarManager } from './status-bar';
import { AutoAcceptService, ALL_AUTO_SETTINGS } from './auto-accept';
import { SidebarProvider, SidebarState } from './sidebar/provider';
import { getGroupForModel, getModelDisplayName, getModelAbbreviation, MODEL_GROUPS } from './model-groups';

let pollingTimer: ReturnType<typeof setInterval> | undefined;
let cacheTimer: ReturnType<typeof setInterval> | undefined;
let bootTimer: ReturnType<typeof setTimeout> | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
    initLogger(ctx);
    logInfo('Antigravity Monitor: Activating…');

    const configManager = new ConfigManager();
    const cfg = configManager.getConfig();
    setDebugMode(cfg['system.debugMode']);

    const storageService = new StorageService(ctx.globalState);
    const cacheManager = new CacheManager();
    const autoAccept = new AutoAcceptService(cfg['system.autoAcceptInterval'], {
        commands: cfg['system.autoAcceptCommands'],
        enabledSettings: cfg['system.autoAcceptSettings'],
        acceptKeywords: cfg['system.autoAcceptKeywords'],
        rejectKeywords: cfg['system.autoAcceptRejectKeywords'],
    });
    ctx.subscriptions.push({ dispose: () => autoAccept.dispose() });

    if (cfg['system.autoAccept']) autoAccept.start();

    let serverInfo: ServerInfo | null = null;
    let lastSnapshot: QuotaSnapshot | null = null;
    let lastCacheSize = 0;
    let connectionStatus: 'detecting' | 'connected' | 'failed' = 'detecting';
    let isRefreshing = false;

    // Deduplicate threshold notifications per session
    const notifiedCritical = new Set<string>();

    const statusBar = new StatusBarManager(configManager);
    ctx.subscriptions.push({ dispose: () => statusBar.dispose() });
    statusBar.showLoading();

    const sidebar = new SidebarProvider(ctx.extensionUri);

    const expandedTasks = new Set<string>();
    const expandedContexts = new Set<string>();
    const taskFilesCache = new Map<string, { name: string; path: string }[]>();
    const contextFilesCache = new Map<string, { name: string; path: string }[]>();
    let tasksExpanded = false;
    let contextsExpanded = false;

    sidebar.setMessageHandler(async (msg: any) => {
        switch (msg.type) {
            case 'webviewReady':
                pushSidebarState();
                break;
            case 'toggleAutoAccept':
                autoAccept.toggle();
                logInfo(`Auto-accept toggled: ${autoAccept.isRunning() ? 'ON' : 'OFF'}`);
                await configManager.update('system.autoAccept', autoAccept.isRunning());
                pushSidebarState();
                break;
            case 'updateAutoAcceptConfig': {
                const c = msg.config;
                if (c) {
                    if (c.commands) {
                        autoAccept.updateCommands(c.commands);
                        await configManager.update('system.autoAcceptCommands', c.commands);
                    }
                    if (c.enabledSettings) {
                        autoAccept.updateEnabledSettings(c.enabledSettings);
                        await configManager.update('system.autoAcceptSettings', c.enabledSettings);
                    }
                    if (c.acceptKeywords) {
                        await configManager.update('system.autoAcceptKeywords', c.acceptKeywords);
                    }
                    if (c.rejectKeywords) {
                        await configManager.update('system.autoAcceptRejectKeywords', c.rejectKeywords);
                    }
                    if (c.acceptKeywords || c.rejectKeywords) {
                        const kw = autoAccept.getConfig();
                        autoAccept.updateKeywords(
                            c.acceptKeywords ?? kw.acceptKeywords,
                            c.rejectKeywords ?? kw.rejectKeywords
                        );
                    }
                    if (typeof c.interval === 'number') {
                        autoAccept.updateInterval(c.interval);
                        await configManager.update('system.autoAcceptInterval', c.interval);
                    }
                    vscode.window.showInformationMessage('✅ Auto-accept config saved');
                    pushSidebarState();
                }
                break;
            }
            case 'toggleTasks':
                tasksExpanded = !tasksExpanded;
                pushSidebarState();
                break;
            case 'toggleProjects':
                contextsExpanded = !contextsExpanded;
                pushSidebarState();
                break;
            case 'toggleTask':
                if (msg.taskId) {
                    if (expandedTasks.has(msg.taskId)) {
                        expandedTasks.delete(msg.taskId);
                    } else {
                        expandedTasks.add(msg.taskId);
                        if (!taskFilesCache.has(msg.taskId)) {
                            const files = await cacheManager.getTaskFiles(msg.taskId);
                            taskFilesCache.set(msg.taskId, files);
                        }
                    }
                    pushSidebarState();
                }
                break;
            case 'toggleContext':
                if (msg.contextId) {
                    if (expandedContexts.has(msg.contextId)) {
                        expandedContexts.delete(msg.contextId);
                    } else {
                        expandedContexts.add(msg.contextId);
                        if (!contextFilesCache.has(msg.contextId)) {
                            const files = await cacheManager.getContextFiles(msg.contextId);
                            contextFilesCache.set(msg.contextId, files);
                        }
                    }
                    pushSidebarState();
                }
                break;
            case 'deleteTask':
                if (msg.taskId) {
                    const answer = await vscode.window.showWarningMessage(
                        `Delete task ${msg.taskId.substring(0, 8)}...?`, { modal: true }, 'Delete'
                    );
                    if (answer === 'Delete') {
                        await cacheManager.deleteTask(msg.taskId);
                        expandedTasks.delete(msg.taskId);
                        taskFilesCache.delete(msg.taskId);
                        await refreshCache();
                    }
                }
                break;
            case 'deleteContext':
                if (msg.contextId) {
                    const answer = await vscode.window.showWarningMessage(
                        `Delete context ${msg.contextId}?`, { modal: true }, 'Delete'
                    );
                    if (answer === 'Delete') {
                        await cacheManager.deleteContext(msg.contextId);
                        expandedContexts.delete(msg.contextId);
                        contextFilesCache.delete(msg.contextId);
                        await refreshCache();
                    }
                }
                break;
        }
    });

    // Register sidebar
    ctx.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar)
    );

    async function detectServer(): Promise<boolean> {
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        logDebug(`Detecting server, workspace: ${wsPath || 'none'}`);
        serverInfo = await findAntigravityProcess(wsPath);
        if (serverInfo) {
            connectionStatus = 'connected';
            logInfo(`Connected on port ${serverInfo.port}`);
            return true;
        }
        return false;
    }

    async function refreshQuota(): Promise<void> {
        if (isRefreshing) return;
        isRefreshing = true;
        try {
            if (!serverInfo) {
                if (!await detectServer()) return;
            }
            const cfg = configManager.getConfig();
            const snapshot = await fetchQuota(
                serverInfo!.port,
                serverInfo!.csrfToken,
                cfg['system.serverHost'],
                cfg['system.apiPath']
            );
            lastSnapshot = snapshot;
            connectionStatus = 'connected';

            // Record absolute credit values (not %) for usage history
            const usage: Record<string, number> = {};
            if (snapshot.tokenUsage?.promptCredits) {
                usage['prompt'] = snapshot.tokenUsage.promptCredits.available;
            }
            if (snapshot.tokenUsage?.flowCredits) {
                usage['flow'] = snapshot.tokenUsage.flowCredits.available;
            }
            await storageService.recordQuotaPoint(usage);
            await storageService.setLastSnapshot(snapshot);
            if (snapshot.userInfo) await storageService.setLastUserInfo(snapshot.userInfo);
            if (snapshot.tokenUsage) await storageService.setLastTokenUsage(snapshot.tokenUsage);

            statusBar.update(snapshot, lastCacheSize);
            checkThresholdNotifications(snapshot);
            pushSidebarState();
        } catch (err) {
            // Re-detect on failure
            logWarn('Quota fetch failed, re-detecting server...');
            serverInfo = null;
            if (await detectServer()) {
                try {
                    const cfg = configManager.getConfig();
                    const snapshot = await fetchQuota(serverInfo!.port, serverInfo!.csrfToken, cfg['system.serverHost'], cfg['system.apiPath']);
                    lastSnapshot = snapshot;
                    statusBar.update(snapshot, lastCacheSize);
                    checkThresholdNotifications(snapshot);
                    pushSidebarState();
                    return;
                } catch { /* fall through */ }
            }
            connectionStatus = 'failed';
            statusBar.showError('Connection lost');
            pushSidebarState();
        } finally {
            isRefreshing = false;
        }
    }

    async function refreshCache(): Promise<void> {
        try {
            const info = await cacheManager.getCacheInfo();
            lastCacheSize = info.totalSize;
            await storageService.setLastCacheSize(info.totalSize);
            statusBar.update(lastSnapshot, lastCacheSize);
            pushSidebarState();
        } catch (err) {
            logError('Cache refresh failed', err);
        }
    }

    function pushSidebarState(): void {
        const cfg = configManager.getConfig();
        const state = buildSidebarState(cfg);
        sidebar.postUpdate(state);
    }

    function buildSidebarState(cfg: ReturnType<typeof configManager.getConfig>): SidebarState {
        const quotas: SidebarState['quotas'] = [];
        const viewMode = cfg['dashboard.viewMode'];

        if (lastSnapshot) {
            if (viewMode === 'models') {
                for (const model of lastSnapshot.models) {
                    const g = getGroupForModel(model.modelId, model.label);
                    const displayName = getModelDisplayName(model.modelId, model.label);
                    const pct = model.timeUntilReset === 'Ready' ? 100 : model.remainingPct;
                    quotas.push({
                        id: model.modelId,
                        label: displayName,
                        remaining: pct,
                        resetTime: model.timeUntilReset,
                        hasData: true,
                        themeColor: g.themeColor,
                    });
                }
            } else {
                const grouped = new Map<string, { remaining: number; resetTime: string; hasData: boolean }>();
                for (const model of lastSnapshot.models) {
                    const g = getGroupForModel(model.modelId, model.label);
                    const existing = grouped.get(g.id);
                    const pct = model.timeUntilReset === 'Ready' ? 100 : model.remainingPct;
                    if (!existing || pct < existing.remaining) {
                        grouped.set(g.id, { remaining: pct, resetTime: model.timeUntilReset, hasData: true });
                    }
                }
                for (const g of MODEL_GROUPS) {
                    const data = grouped.get(g.id);
                    quotas.push({
                        id: g.id,
                        label: g.label,
                        remaining: data?.remaining ?? 0,
                        resetTime: data?.resetTime ?? 'N/A',
                        hasData: data?.hasData ?? false,
                        themeColor: g.themeColor,
                    });
                }
            }
        }

        // Build chart — raw history points for sparkline
        const rangeMin = cfg['dashboard.historyRange'];
        const historyPoints = storageService.getRecentHistory(rangeMin);
        const chartPoints = historyPoints.map(p => ({
            t: p.timestamp,
            prompt: p.usage['prompt'] ?? 0,
            flow: p.usage['flow'] ?? 0,
        }));
        const sessionConsumption = storageService.getSessionConsumption();

        // Cache info
        const cacheInfo = {
            totalSize: lastCacheSize,
            brainSize: 0,
            conversationsSize: 0,
            brainCount: 0,
            formattedTotal: formatSize(lastCacheSize),
            formattedBrain: '—',
            formattedConversations: '—',
        };

        const tasks: SidebarState['tasks'] = {
            expanded: tasksExpanded,
            folders: [],
        };
        const contexts: SidebarState['contexts'] = {
            expanded: contextsExpanded,
            folders: [],
        };

        // Async: populate task/context trees and push an update when ready
        const stateRef = { current: null as SidebarState | null };
        cacheManager.getCacheInfo().then(info => {
            cacheInfo.brainSize = info.brainSize;
            cacheInfo.conversationsSize = info.conversationsSize;
            cacheInfo.brainCount = info.brainCount;
            cacheInfo.formattedBrain = formatSize(info.brainSize);
            cacheInfo.formattedConversations = formatSize(info.conversationsSize);

            tasks.folders = info.brainTasks.map(t => ({
                id: t.id,
                label: t.label,
                size: formatSize(t.size),
                expanded: expandedTasks.has(t.id),
                files: expandedTasks.has(t.id) ? (taskFilesCache.get(t.id) || []) : [],
            }));

            contexts.folders = info.codeContexts.map(c => ({
                id: c.id,
                label: c.name,
                size: formatSize(c.size),
                expanded: expandedContexts.has(c.id),
                files: expandedContexts.has(c.id) ? (contextFilesCache.get(c.id) || []) : [],
            }));

            if (stateRef.current) {
                sidebar.postUpdate({
                    ...stateRef.current,
                    cache: cacheInfo,
                    tasks,
                    contexts,
                });
            }
        }).catch(() => { });

        const state: SidebarState = {
            connectionStatus,
            quotas,
            chart: { points: chartPoints, displayMinutes: rangeMin, sessionConsumption },
            cache: cacheInfo,
            user: lastSnapshot?.userInfo ? {
                name: lastSnapshot.userInfo.name,
                email: lastSnapshot.userInfo.email,
                tier: lastSnapshot.userInfo.tier,
                planName: lastSnapshot.userInfo.planName,
            } : storageService.getLastUserInfo() || undefined,
            tokenUsage: lastSnapshot?.tokenUsage ? {
                promptCredits: lastSnapshot.tokenUsage.promptCredits ? {
                    available: lastSnapshot.tokenUsage.promptCredits.available,
                    monthly: lastSnapshot.tokenUsage.promptCredits.monthly,
                    remainingPct: lastSnapshot.tokenUsage.promptCredits.remainingPct,
                } : undefined,
                flowCredits: lastSnapshot.tokenUsage.flowCredits ? {
                    available: lastSnapshot.tokenUsage.flowCredits.available,
                    monthly: lastSnapshot.tokenUsage.flowCredits.monthly,
                    remainingPct: lastSnapshot.tokenUsage.flowCredits.remainingPct,
                } : undefined,
                totalAvailable: lastSnapshot.tokenUsage.totalAvailable,
                totalMonthly: lastSnapshot.tokenUsage.totalMonthly,
                overallRemainingPct: lastSnapshot.tokenUsage.overallRemainingPct,
            } : storageService.getLastTokenUsage() || undefined,
            tasks,
            contexts,
            autoAcceptEnabled: autoAccept.isRunning(),
            autoAcceptConfig: {
                ...autoAccept.getConfig(),
                allSettings: ALL_AUTO_SETTINGS.map(s => ({ key: s.key, label: s.key.split('.').pop() || s.key })),
                interval: configManager.get('system.autoAcceptInterval', 800),
            },
            gaugeStyle: cfg['dashboard.gaugeStyle'],
            showUserInfoCard: cfg['dashboard.showUserInfoCard'],
            showCreditsCard: cfg['dashboard.showCreditsCard'],
            uiScale: cfg['dashboard.uiScale'],
        };
        stateRef.current = state;
        return state;
    }

    ctx.subscriptions.push(
        vscode.commands.registerCommand('agm.openPanel', () => {
            vscode.commands.executeCommand('workbench.view.extension.agm-sidebar');
        }),
        vscode.commands.registerCommand('agm.refreshQuota', async () => {
            await refreshQuota();
            vscode.window.showInformationMessage('Antigravity Monitor: Data updated.');
        }),
        vscode.commands.registerCommand('agm.showCacheSize', () => {
            vscode.window.showInformationMessage(`Cache size: ${formatSize(lastCacheSize)}`);
        }),
        vscode.commands.registerCommand('agm.cleanCache', async () => {
            const keepCount = configManager.get('cache.autoCleanKeepCount', 5);
            const result = await cacheManager.cleanCache(keepCount);
            await refreshCache();
            vscode.window.showInformationMessage(
                `Cleaned ${result.deletedCount} tasks, freed ${formatSize(result.freedBytes)}`
            );
        }),
        vscode.commands.registerCommand('agm.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-build.antigravity-monitor');
        }),
        vscode.commands.registerCommand('agm.restartLanguageServer', async () => {
            try {
                await vscode.commands.executeCommand('antigravity.restartLanguageServer');
                vscode.window.showInformationMessage('Agent service restarted.');
            } catch {
                vscode.window.showErrorMessage('Failed to restart agent service.');
            }
        }),
        vscode.commands.registerCommand('agm.resetStatus', async () => {
            try {
                await vscode.commands.executeCommand('antigravity.restartUserStatusUpdater');
                vscode.window.showInformationMessage('Status updater reset.');
            } catch {
                vscode.window.showErrorMessage('Failed to reset status updater.');
            }
        }),
        vscode.commands.registerCommand('agm.runDiagnostics', async () => {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Running diagnostics...', cancellable: false },
                async () => {
                    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    const result = await findAntigravityProcess(wsPath);
                    if (result) {
                        vscode.window.showInformationMessage(
                            `✅ Connected: Port ${result.port}, CSRF ${result.csrfToken.substring(0, 8)}...`
                        );
                    } else {
                        vscode.window.showWarningMessage(
                            '❌ Could not detect Antigravity language server. Ensure the IDE is running.'
                        );
                    }
                }
            );
        }),
        vscode.commands.registerCommand('agm.showLogs', () => {
            const ch = getOutputChannel();
            if (ch) ch.show(true);
            else vscode.window.showWarningMessage('Output channel not initialized.');
        }),
        vscode.commands.registerCommand('agm.toggleAutoAccept', async () => {
            autoAccept.toggle();
            await configManager.update('system.autoAccept', autoAccept.isRunning());
            vscode.window.showInformationMessage(
                autoAccept.isRunning() ? 'Auto-Accept: ON' : 'Auto-Accept: OFF'
            );
            pushSidebarState();
        }),
        vscode.commands.registerCommand('agm.showQuickPick', () => showQuickPick()),
    );

    function showQuickPick(): void {
        const pick = vscode.window.createQuickPick();
        pick.title = '$(rocket) Antigravity Monitor — Quota Details';
        pick.placeholder = 'Click a model to view details • Ctrl+Shift+Q to toggle';
        pick.matchOnDescription = false;
        pick.matchOnDetail = false;
        pick.canSelectMany = false;
        pick.items = buildQuickPickItems();

        let currentItem: vscode.QuickPickItem | undefined;
        pick.onDidChangeActive(items => { currentItem = items[0]; });
        pick.onDidAccept(() => {
            if (currentItem && 'modelId' in currentItem) {
                const model = lastSnapshot?.models.find(m => m.modelId === (currentItem as any).modelId);
                if (model) {
                    const dn = getModelDisplayName(model.modelId, model.label);
                    vscode.window.showInformationMessage(
                        `${dn}: ${model.remainingPct.toFixed(1)}% remaining — Resets in ${model.timeUntilReset}`
                    );
                }
            }
        });
        pick.onDidHide(() => pick.dispose());
        pick.show();
    }

    function buildQuickPickItems(): vscode.QuickPickItem[] {
        const items: vscode.QuickPickItem[] = [];
        const warnThresh = configManager.get('status.warningThreshold', 30);
        const critThresh = configManager.get('status.criticalThreshold', 10);

        items.push({ label: 'Model Quotas', kind: vscode.QuickPickItemKind.Separator });

        if (lastSnapshot && lastSnapshot.models.length > 0) {
            for (const m of lastSnapshot.models) {
                const dn = getModelDisplayName(m.modelId, m.label);
                const pct = m.remainingPct;
                const bar = drawProgressBar(pct);
                const icon = m.isExhausted ? '$(error)' : pct < critThresh ? '$(error)' : pct < warnThresh ? '$(warning)' : '$(check)';
                const item: vscode.QuickPickItem & { modelId?: string } = {
                    label: `${icon} ${dn}`,
                    description: `${bar} ${pct.toFixed(1)}%`,
                    detail: `    Resets in: ${m.timeUntilReset}`,
                };
                (item as any).modelId = m.modelId;
                items.push(item);
            }
        } else {
            items.push({
                label: '$(info) No model data',
                description: 'Waiting for quota info...',
            });
        }

        // Credits section
        if (lastSnapshot?.tokenUsage) {
            items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
            items.push({ label: 'Credits', kind: vscode.QuickPickItemKind.Separator });
            const tu = lastSnapshot.tokenUsage;
            items.push({
                label: `$(credit-card) ${tu.totalAvailable.toLocaleString()} / ${tu.totalMonthly.toLocaleString()}`,
                description: `${drawProgressBar(tu.overallRemainingPct)} ${tu.overallRemainingPct.toFixed(1)}%`,
            });
        }

        // Auto-accept status
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: `$(check-all) Auto-Accept: ${autoAccept.isRunning() ? 'ON' : 'OFF'}`,
            description: 'Ctrl+Shift+A to toggle',
        });

        return items;
    }

    function drawProgressBar(pct: number): string {
        const total = 10;
        const clamped = Math.max(0, Math.min(100, pct));
        const filled = Math.round((clamped / 100) * total);
        return '▓'.repeat(filled) + '░'.repeat(total - filled);
    }

    function checkThresholdNotifications(snapshot: QuotaSnapshot): void {
        const notify = configManager.get('status.notificationsEnabled', true);
        if (!notify) return;
        const critThresh = configManager.get('status.criticalThreshold', 10);

        for (const model of snapshot.models) {
            if (model.remainingPct < critThresh && !model.isExhausted && !notifiedCritical.has(model.modelId)) {
                notifiedCritical.add(model.modelId);
                const dn = getModelDisplayName(model.modelId, model.label);
                vscode.window.showWarningMessage(
                    `⚠️ ${dn} quota is at ${model.remainingPct.toFixed(1)}% — below critical threshold (${critThresh}%)`
                );
            }
            if (model.remainingPct >= critThresh && notifiedCritical.has(model.modelId)) {
                notifiedCritical.delete(model.modelId);
            }
        }
    }

    ctx.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('agm')) {
                const newCfg = configManager.getConfig();
                setDebugMode(newCfg['system.debugMode']);
                autoAccept.updateInterval(newCfg['system.autoAcceptInterval']);
                autoAccept.updateCommands(newCfg['system.autoAcceptCommands']);
                autoAccept.updateEnabledSettings(newCfg['system.autoAcceptSettings']);
                autoAccept.updateKeywords(newCfg['system.autoAcceptKeywords'], newCfg['system.autoAcceptRejectKeywords']);

                if (newCfg['system.autoAccept'] !== autoAccept.isRunning()) {
                    if (newCfg['system.autoAccept']) autoAccept.start();
                    else autoAccept.stop();
                }

                startPolling();
                startCacheTimer();

                statusBar.update(lastSnapshot, lastCacheSize);
                pushSidebarState();
            }
        })
    );

    function startPolling(): void {
        if (pollingTimer) clearInterval(pollingTimer);
        const interval = configManager.get('dashboard.refreshRate', 90) * 1000;
        pollingTimer = setInterval(() => refreshQuota(), interval);
    }

    function startCacheTimer(): void {
        if (cacheTimer) clearInterval(cacheTimer);
        const interval = configManager.get('cache.scanInterval', 120) * 1000;
        cacheTimer = setInterval(() => refreshCache(), interval);
    }

    let retryCount = 0;
    const maxRetries = 5;
    const retryDelay = 3000;

    async function boot(): Promise<void> {
        if (await detectServer()) {
            await refreshQuota();
            await refreshCache();
            startPolling();
            startCacheTimer();
            logInfo('Startup complete');
        } else {
            retryCount++;
            if (retryCount <= maxRetries) {
                logWarn(`Server not found, retry ${retryCount}/${maxRetries} in ${retryDelay / 1000}s...`);
                connectionStatus = 'detecting';
                pushSidebarState();
                bootTimer = setTimeout(boot, retryDelay);
            } else {
                connectionStatus = 'failed';
                statusBar.showError('Server not found');
                pushSidebarState();
                logError('Could not connect to Antigravity language server after retries.');
                vscode.window.showWarningMessage(
                    'Antigravity Monitor: Could not detect language server. Is Antigravity IDE running?'
                );
            }
        }
    }

    bootTimer = setTimeout(boot, 2000);

    logInfo('Antigravity Monitor: Activated');
}

export function deactivate(): void {
    if (pollingTimer) clearInterval(pollingTimer);
    if (cacheTimer) clearInterval(cacheTimer);
    if (bootTimer) clearTimeout(bootTimer);
}
