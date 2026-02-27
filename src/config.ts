import * as vscode from 'vscode';

export interface AgmConfig {
    'dashboard.gaugeStyle': string;
    'dashboard.viewMode': string;
    'dashboard.historyRange': number;
    'dashboard.refreshRate': number;
    'dashboard.uiScale': number;
    'dashboard.showUserInfoCard': boolean;
    'dashboard.showCreditsCard': boolean;
    'status.showQuota': boolean;
    'status.showCache': boolean;
    'status.displayFormat': string;
    'status.scope': string;
    'status.warningThreshold': number;
    'status.criticalThreshold': number;
    'status.notificationsEnabled': boolean;
    'cache.autoClean': boolean;
    'cache.autoCleanKeepCount': number;
    'cache.scanInterval': number;
    'cache.warningSize': number;
    'cache.hideEmptyFolders': boolean;
    'system.serverHost': string;
    'system.apiPath': string;
    'system.debugMode': boolean;
    'system.autoAccept': boolean;
    'system.autoAcceptInterval': number;
}

const MIN_REFRESH = 30;
const MIN_CACHE_SCAN = 30;
const MIN_AUTO_ACCEPT = 200;

export class ConfigManager {
    private section = 'agm';

    get<T>(key: string, fallback: T): T {
        const val = vscode.workspace.getConfiguration(this.section).get<T>(key, fallback);
        if (key === 'dashboard.refreshRate' && typeof val === 'number') return Math.max(val, MIN_REFRESH) as T;
        if (key === 'cache.scanInterval' && typeof val === 'number') return Math.max(val, MIN_CACHE_SCAN) as T;
        if (key === 'system.autoAcceptInterval' && typeof val === 'number') return Math.max(val, MIN_AUTO_ACCEPT) as T;
        return val;
    }

    async update(key: string, value: unknown): Promise<void> {
        await vscode.workspace.getConfiguration(this.section).update(key, value, vscode.ConfigurationTarget.Global);
    }

    getConfig(): AgmConfig {
        return {
            'dashboard.gaugeStyle': this.get('dashboard.gaugeStyle', 'semi-arc'),
            'dashboard.viewMode': this.get('dashboard.viewMode', 'groups'),
            'dashboard.historyRange': this.get('dashboard.historyRange', 90),
            'dashboard.refreshRate': this.get('dashboard.refreshRate', 90),
            'dashboard.uiScale': Math.min(Math.max(this.get('dashboard.uiScale', 1), 0.8), 2),
            'dashboard.showUserInfoCard': this.get('dashboard.showUserInfoCard', true),
            'dashboard.showCreditsCard': this.get('dashboard.showCreditsCard', true),
            'status.showQuota': this.get('status.showQuota', true),
            'status.showCache': this.get('status.showCache', true),
            'status.displayFormat': this.get('status.displayFormat', 'percentage'),
            'status.scope': this.get('status.scope', 'all'),
            'status.warningThreshold': this.get('status.warningThreshold', 30),
            'status.criticalThreshold': this.get('status.criticalThreshold', 10),
            'status.notificationsEnabled': this.get('status.notificationsEnabled', true),
            'cache.autoClean': this.get('cache.autoClean', false),
            'cache.autoCleanKeepCount': this.get('cache.autoCleanKeepCount', 5),
            'cache.scanInterval': this.get('cache.scanInterval', 120),
            'cache.warningSize': this.get('cache.warningSize', 500),
            'cache.hideEmptyFolders': this.get('cache.hideEmptyFolders', false),
            'system.serverHost': this.get('system.serverHost', '127.0.0.1'),
            'system.apiPath': this.get('system.apiPath', '/exa.language_server_pb.LanguageServerService/GetUserStatus'),
            'system.debugMode': this.get('system.debugMode', false),
            'system.autoAccept': this.get('system.autoAccept', false),
            'system.autoAcceptInterval': this.get('system.autoAcceptInterval', 800),
        };
    }
}
