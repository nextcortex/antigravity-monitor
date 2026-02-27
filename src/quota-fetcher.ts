/**
 * Quota fetcher — calls the local Antigravity GetUserStatus API
 * and parses per-model quotas, credits, and user info.
 * All requests go to 127.0.0.1 only — no external traffic.
 */
import * as http from 'http';
import * as https from 'https';
import { logDebug, logWarn } from './logger';

export interface ModelQuota {
    label: string;
    modelId: string;
    remainingPct: number;
    isExhausted: boolean;
    resetTime: Date;
    timeUntilReset: string;
}

export interface CreditsInfo {
    available: number;
    monthly: number;
    remainingPct: number;
}

export interface UserInfo {
    name?: string;
    email?: string;
    tier?: string;
    tierDescription?: string;
    planName?: string;
    browserEnabled?: boolean;
    knowledgeBaseEnabled?: boolean;
}

export interface TokenUsage {
    promptCredits?: CreditsInfo;
    flowCredits?: CreditsInfo;
    totalAvailable: number;
    totalMonthly: number;
    overallRemainingPct: number;
}

export interface QuotaSnapshot {
    models: ModelQuota[];
    userInfo?: UserInfo;
    tokenUsage?: TokenUsage;
    timestamp: Date;
}

export async function fetchQuota(
    port: number,
    csrfToken: string,
    host: string = '127.0.0.1',
    apiPath: string = '/exa.language_server_pb.LanguageServerService/GetUserStatus'
): Promise<QuotaSnapshot> {
    const data = await postWithFallback(port, csrfToken, host, apiPath, {
        metadata: {
            ideName: 'antigravity',
            extensionName: 'antigravity',
            locale: 'en',
        },
    });
    return parseResponse(data);
}

async function postWithFallback(
    port: number, csrfToken: string, host: string, path: string, body: unknown
): Promise<any> {
    try {
        return await post(port, csrfToken, host, path, body, 'http');
    } catch {
        return await post(port, csrfToken, host, path, body, 'https');
    }
}

function post(
    port: number, csrfToken: string, host: string, path: string, body: unknown, protocol: 'http' | 'https'
): Promise<any> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const lib = protocol === 'https' ? https : http;
        const req = lib.request({
            hostname: host,
            port,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrfToken,
            },
            rejectUnauthorized: false,
            timeout: 10000,
        }, res => {
            let raw = '';
            res.on('data', (chunk: Buffer) => (raw += chunk));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(raw));
                } catch {
                    reject(new Error('Invalid JSON from Antigravity API'));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(payload);
        req.end();
    });
}

function parseResponse(data: any): QuotaSnapshot {
    const userStatus = data.userStatus;
    const planInfo = userStatus?.planStatus?.planInfo;
    const availablePrompt = userStatus?.planStatus?.availablePromptCredits;
    const availableFlow = userStatus?.planStatus?.availableFlowCredits;

    // Prompt credits
    let promptCredits: CreditsInfo | undefined;
    if (planInfo && availablePrompt !== undefined) {
        const monthly = Number(planInfo.monthlyPromptCredits);
        const available = Number(availablePrompt);
        if (monthly > 0) {
            promptCredits = { available, monthly, remainingPct: (available / monthly) * 100 };
        }
    }

    // Flow credits
    let flowCredits: CreditsInfo | undefined;
    if (planInfo?.monthlyFlowCredits && availableFlow !== undefined) {
        const monthly = Number(planInfo.monthlyFlowCredits);
        const available = Number(availableFlow);
        if (monthly > 0) {
            flowCredits = { available, monthly, remainingPct: (available / monthly) * 100 };
        }
    }

    // Token usage aggregate
    let tokenUsage: TokenUsage | undefined;
    if (promptCredits || flowCredits) {
        const totalAvailable = (promptCredits?.available || 0) + (flowCredits?.available || 0);
        const totalMonthly = (promptCredits?.monthly || 0) + (flowCredits?.monthly || 0);
        tokenUsage = {
            promptCredits,
            flowCredits,
            totalAvailable,
            totalMonthly,
            overallRemainingPct: totalMonthly > 0 ? (totalAvailable / totalMonthly) * 100 : 0,
        };
    }

    // User info
    const tier = userStatus?.userTier;
    let userInfo: UserInfo | undefined;
    if (userStatus?.name || tier) {
        userInfo = {
            name: userStatus.name,
            email: userStatus.email,
            tier: tier?.name || planInfo?.teamsTier,
            tierDescription: tier?.description,
            planName: planInfo?.planName,
            browserEnabled: planInfo?.browserEnabled,
            knowledgeBaseEnabled: planInfo?.knowledgeBaseEnabled,
        };
    }

    // Per-model quotas
    const rawModels = userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const models: ModelQuota[] = rawModels
        .filter((m: any) => m.quotaInfo)
        .map((m: any) => {
            const resetTime = new Date(m.quotaInfo.resetTime);
            const diff = resetTime.getTime() - Date.now();
            const fraction = m.quotaInfo.remainingFraction ?? 0;
            return {
                label: m.label || 'Unknown',
                modelId: m.modelOrAlias?.model || 'unknown',
                remainingPct: fraction * 100,
                isExhausted: fraction === 0,
                resetTime,
                timeUntilReset: formatTime(diff),
            };
        });

    return { models, userInfo, tokenUsage, timestamp: new Date() };
}

function formatTime(ms: number): string {
    if (ms <= 0) return 'Ready';
    const mins = Math.ceil(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    if (h >= 24) {
        const d = Math.floor(h / 24);
        const remH = h % 24;
        return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
    }
    return `${h}h ${mins % 60}m`;
}
