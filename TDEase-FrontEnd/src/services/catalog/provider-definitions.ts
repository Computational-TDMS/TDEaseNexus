/**
 * Provider definitions — provider set originally from openhanako-main/lib/providers/,
 * refreshed 2026-08-25 against pi upstream (@earendil-works/pi-ai 0.84.3, catalog
 * generated 2026-08-24) plus vendor status research for CN providers pi does not ship.
 *
 * Each object is the canonical { id, displayName, authType, defaultBaseUrl, defaultApi }.
 * Inlined here so we don't drag the pi-sdk import chain (which requires
 * @earendil-works/pi-coding-agent etc.). `defaultApi` values must be api names the
 * installed pi-ai understands (anthropic-messages / openai-completions /
 * openai-responses / openai-codex-responses / google-generative-ai /
 * mistral-conversations), or a TDEase-local adapter (volcengine-bigasr, system-speech).
 */

export interface ProviderDef {
  id: string
  displayName: string
  authType: 'api-key' | 'oauth' | 'none'
  defaultBaseUrl: string
  defaultApi: string
  /** The six marquee vendors surfaced uncollapsed in pickers; everything else
   *  folds behind "more providers". Domestic trio first, then the big three. */
  featured?: boolean
  /** Vendor console page where an API key is issued — the settings detail
   *  links it next to the key field. */
  keyUrl?: string
}

/** Display order for featured providers. Ids must all exist in PROVIDERS. */
export const FEATURED_PROVIDER_IDS = [
  'deepseek', 'zhipu', 'moonshot', // three domestic providers
  'openai', 'anthropic', 'gemini', // the big three abroad
] as const

export const PROVIDERS: ProviderDef[] = [
  { id: 'agnes',             displayName: 'Agnes AI',              authType: 'api-key', defaultBaseUrl: 'https://apihub.agnes-ai.com/v1',          defaultApi: 'openai-completions' },
  { id: 'anthropic',         displayName: 'Anthropic',             authType: 'api-key', defaultBaseUrl: 'https://api.anthropic.com',                defaultApi: 'anthropic-messages',     featured: true, keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'baichuan',          displayName: 'Baichuan AI',            authType: 'api-key', defaultBaseUrl: 'https://api.baichuan-ai.com/v1',            defaultApi: 'openai-completions' },
  { id: 'baidu-cloud',       displayName: 'Baidu AI Cloud (ERNIE)', authType: 'api-key', defaultBaseUrl: 'https://qianfan.baidubce.com/v2',           defaultApi: 'openai-completions' },
  { id: 'dashscope',         displayName: 'Alibaba Cloud Bailian (DashScope)', authType: 'api-key', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultApi: 'openai-completions' },
  { id: 'dashscope-coding',  displayName: 'Bailian Coding Plan',    authType: 'api-key', defaultBaseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', defaultApi: 'openai-completions' },
  { id: 'deepseek',          displayName: 'DeepSeek',              authType: 'api-key', defaultBaseUrl: 'https://api.deepseek.com',                  defaultApi: 'openai-completions',     featured: true, keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'fireworks',         displayName: 'Fireworks AI',          authType: 'api-key', defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',      defaultApi: 'openai-completions' },
  { id: 'gemini',            displayName: 'Google Gemini',         authType: 'api-key', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultApi: 'google-generative-ai', featured: true, keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'groq',              displayName: 'Groq',                  authType: 'api-key', defaultBaseUrl: 'https://api.groq.com/openai/v1',             defaultApi: 'openai-completions' },
  { id: 'hunyuan',           displayName: 'Tencent Hunyuan',        authType: 'api-key', defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',    defaultApi: 'openai-completions' },
  { id: 'infini',            displayName: 'Infini',                 authType: 'api-key', defaultBaseUrl: 'https://cloud.infini-ai.com/maas/v1',        defaultApi: 'openai-completions' },
  { id: 'kimi-coding',       displayName: 'Kimi Coding Plan',      authType: 'api-key', defaultBaseUrl: 'https://api.kimi.com/coding',                defaultApi: 'anthropic-messages' },
  { id: 'mimo',              displayName: 'Xiaomi (MiMo)',         authType: 'api-key', defaultBaseUrl: 'https://api.xiaomimimo.com/v1',              defaultApi: 'openai-completions' },
  { id: 'mimo-token-plan',   displayName: 'Xiaomi MiMo Token Plan', authType: 'api-key', defaultBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',    defaultApi: 'openai-completions' },
  { id: 'minimax',           displayName: 'MiniMax (International)', authType: 'api-key', defaultBaseUrl: 'https://api.minimax.io/anthropic',           defaultApi: 'anthropic-messages' },
  { id: 'minimax-token-plan',displayName: 'MiniMax (CN)',           authType: 'api-key', defaultBaseUrl: 'https://api.minimaxi.com/anthropic',          defaultApi: 'anthropic-messages' },
  { id: 'mistral',           displayName: 'Mistral AI',            authType: 'api-key', defaultBaseUrl: 'https://api.mistral.ai',                     defaultApi: 'mistral-conversations' },
  { id: 'modelscope',        displayName: 'ModelScope',             authType: 'api-key', defaultBaseUrl: 'https://api-inference.modelscope.cn/v1',      defaultApi: 'openai-completions' },
  { id: 'moonshot',          displayName: 'Moonshot (Kimi)',       authType: 'api-key', defaultBaseUrl: 'https://api.moonshot.cn/v1',                  defaultApi: 'openai-completions',   featured: true, keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'ollama',            displayName: 'Ollama (Local)',         authType: 'none',    defaultBaseUrl: 'http://localhost:11434/v1',                  defaultApi: 'openai-completions' },
  { id: 'openai',            displayName: 'OpenAI',                authType: 'api-key', defaultBaseUrl: 'https://api.openai.com/v1',                   defaultApi: 'openai-responses',     featured: true, keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'openai-codex-oauth',displayName: 'OpenAI Codex (OAuth)',  authType: 'oauth',   defaultBaseUrl: 'https://chatgpt.com/backend-api',              defaultApi: 'openai-codex-responses' },
  { id: 'opencode',          displayName: 'OpenCode Zen',          authType: 'api-key', defaultBaseUrl: 'https://opencode.ai/zen',                     defaultApi: 'anthropic-messages' },
  { id: 'opencode-go',       displayName: 'OpenCode Go',           authType: 'api-key', defaultBaseUrl: 'https://opencode.ai/zen/go/v1',               defaultApi: 'openai-completions' },
  { id: 'openrouter',        displayName: 'OpenRouter',            authType: 'api-key', defaultBaseUrl: 'https://openrouter.ai/api/v1',                defaultApi: 'openai-completions' },
  { id: 'perplexity',        displayName: 'Perplexity',            authType: 'api-key', defaultBaseUrl: 'https://api.perplexity.ai',                   defaultApi: 'openai-completions' },
  { id: 'siliconflow',       displayName: 'SiliconFlow',            authType: 'api-key', defaultBaseUrl: 'https://api.siliconflow.cn/v1',               defaultApi: 'openai-completions' },
  { id: 'stepfun',           displayName: 'StepFun',                authType: 'api-key', defaultBaseUrl: 'https://api.stepfun.com/v1',                   defaultApi: 'openai-completions' },
  { id: 'system-speech',     displayName: 'System Speech Recognition', authType: 'none',  defaultBaseUrl: '',                                               defaultApi: 'system-speech' },
  { id: 'together',          displayName: 'Together AI',           authType: 'api-key', defaultBaseUrl: 'https://api.together.ai/v1',                  defaultApi: 'openai-completions' },
  { id: 'volcengine',        displayName: 'Volcengine (Doubao)',    authType: 'api-key', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',     defaultApi: 'openai-completions' },
  { id: 'volcengine-coding', displayName: 'Volcengine Coding Plan', authType: 'api-key', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', defaultApi: 'openai-completions' },
  { id: 'volcengine-speech', displayName: 'Volcengine Speech (BigASR)', authType: 'api-key', defaultBaseUrl: 'https://openspeech.bytedance.com',         defaultApi: 'volcengine-bigasr' },
  { id: 'xai',               displayName: 'xAI (Grok)',            authType: 'api-key', defaultBaseUrl: 'https://api.x.ai/v1',                         defaultApi: 'openai-responses' },
  { id: 'zhipu',             displayName: 'Zhipu AI (GLM)',         authType: 'api-key', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',        defaultApi: 'openai-completions',   featured: true, keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'zhipu-coding',      displayName: 'Zhipu GLM Coding Plan',  authType: 'api-key', defaultBaseUrl: 'https://api.z.ai/api/coding/paas/v4',          defaultApi: 'openai-completions' },
  { id: 'zhipu-coding-cn',   displayName: 'Zhipu GLM Coding Plan (CN)', authType: 'api-key', defaultBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', defaultApi: 'openai-completions' },
]

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find(p => p.id === id)
}
