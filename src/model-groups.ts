export interface ModelGroup {
    id: string;
    label: string;
    shortLabel: string;
    themeColor: string;
    prefixes: string[];
}

/** Known model ID → display name mapping */
const KNOWN_MODELS: Record<string, string> = {
    // Claude
    'MODEL_CLAUDE_4_5_SONNET': 'Claude Sonnet 4.5',
    'MODEL_CLAUDE_4_5_SONNET_THINKING': 'Claude Sonnet 4.5 (Thinking)',
    'MODEL_PLACEHOLDER_M12': 'Claude Opus 4.5',
    'claude-4-5-sonnet': 'Claude Sonnet 4.5',
    'claude-4-5-sonnet-thinking': 'Claude Sonnet 4.5 (Thinking)',
    'claude-4-opus-thinking': 'Claude Opus 4.5',
    'claude-sonnet-4-5': 'Claude Sonnet 4.5',
    'claude-3-5-sonnet': 'Claude Sonnet 3.5',
    'claude-3-opus': 'Claude Opus 3',
    // Gemini
    'MODEL_PLACEHOLDER_M18': 'Gemini 3 Flash',
    'MODEL_PLACEHOLDER_M8': 'Gemini 3 Pro (High)',
    'MODEL_PLACEHOLDER_M7': 'Gemini 3 Pro (Low)',
    'gemini-3-flash': 'Gemini 3 Flash',
    'gemini-3-pro-high': 'Gemini 3 Pro (High)',
    'gemini-3-pro-low': 'Gemini 3 Pro (Low)',
    'gemini-2-flash': 'Gemini 2 Flash',
    // GPT
    'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': 'GPT-OSS 120B',
    'gpt-oss-120b-medium': 'GPT-OSS 120B',
};

export const MODEL_GROUPS: ModelGroup[] = [
    {
        id: 'gemini-flash',
        label: 'Gemini Flash',
        shortLabel: 'Flash',
        themeColor: '#40C4FF',
        prefixes: ['gemini-3-flash', 'gemini-2-flash', 'flash'],
    },
    {
        id: 'gemini-pro',
        label: 'Gemini Pro',
        shortLabel: 'Pro',
        themeColor: '#69F0AE',
        prefixes: ['gemini'],
    },
    {
        id: 'claude',
        label: 'Claude',
        shortLabel: 'Claude',
        themeColor: '#FFAB40',
        prefixes: ['claude'],
    },
    {
        id: 'gpt',
        label: 'GPT',
        shortLabel: 'GPT',
        themeColor: '#FF5252',
        prefixes: ['gpt'],
    },
];

export function getGroupForModel(modelId: string, label?: string): ModelGroup {
    const lower = ((label || '') + ' ' + modelId).toLowerCase();
    // Check flash before pro (both contain 'gemini')
    for (const g of MODEL_GROUPS) {
        for (const prefix of g.prefixes) {
            if (lower.includes(prefix.toLowerCase())) return g;
        }
    }
    return MODEL_GROUPS[MODEL_GROUPS.length - 1]; // fallback to last group
}

/**
 * Resolves the best display name for a model.
 * Priority: known ID map → API label → raw modelId
 */
export function getModelDisplayName(modelId: string, label?: string): string {
    // 1. Try exact match on modelId
    if (KNOWN_MODELS[modelId]) return KNOWN_MODELS[modelId];
    // 2. Try normalized ID (lowercase, strip MODEL_ prefix, replace _ with -)
    const normalized = modelId.toLowerCase().replace(/^model_/, '').replace(/_/g, '-');
    if (KNOWN_MODELS[normalized]) return KNOWN_MODELS[normalized];
    // 3. Try matching by label
    if (label) {
        for (const [key, displayName] of Object.entries(KNOWN_MODELS)) {
            if (label.toLowerCase().includes(key.toLowerCase().replace(/^model_/, '').replace(/_/g, ' '))) {
                return displayName;
            }
        }
    }
    // 4. Use the API label if available
    if (label && label !== 'Unknown') return label;
    // 5. Fallback: clean up the modelId
    return modelId.replace(/^MODEL_/, '').replace(/_/g, ' ');
}

/** Short abbreviations for status bar display */
const MODEL_ABBREVIATIONS: Record<string, string> = {
    'Claude Sonnet 4.5': 'Claude S4.5',
    'Claude Sonnet 4.5 (Thinking)': 'Claude S4.5T',
    'Claude Opus 4.5': 'Claude O4.5',
    'Claude Sonnet 4.6 (Thinking)': 'Claude S4.6T',
    'Claude Opus 4.6 (Thinking)': 'Claude O4.6T',
    'Claude Sonnet 3.5': 'Claude S3.5',
    'Claude Opus 3': 'Claude O3',
    'Gemini 3 Pro (High)': 'G3 Pro(H)',
    'Gemini 3 Pro (Low)': 'G3 Pro(L)',
    'Gemini 3.1 Pro (High)': 'G3.1 Pro(H)',
    'Gemini 3.1 Pro (Low)': 'G3.1 Pro(L)',
    'Gemini 3 Flash': 'G3 Flash',
    'Gemini 2 Flash': 'G2 Flash',
    'Gemini 3 Pro Image': 'G3 Image',
    'GPT-OSS 120B': 'GPT-OSS',
    'GPT-OSS 120B (Medium)': 'GPT-OSS(M)',
};

/** Get a short abbreviation for status bar */
export function getModelAbbreviation(displayName: string): string {
    if (MODEL_ABBREVIATIONS[displayName]) return MODEL_ABBREVIATIONS[displayName];
    // Auto abbreviation: first letter of each word + keep numbers
    return displayName
        .split(/[\s\-_()]+/)
        .filter(Boolean)
        .map(w => {
            const m = w.match(/^([A-Za-z]?)(.*)$/);
            if (m) return m[1].toUpperCase() + (w.match(/\d+/) || [''])[0];
            return w[0]?.toUpperCase() || '';
        })
        .join('')
        .slice(0, 6);
}
