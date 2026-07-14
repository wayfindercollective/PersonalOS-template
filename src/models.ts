/**
 * Model identifier hygiene for PersonalOS / PersonalOS.
 *
 * Claude Code family aliases (opus / sonnet / haiku / fable / best) resolve to
 * the current recommended model for the provider and update over time.
 * Versioned IDs like claude-opus-4-6 go stale when Anthropic ships newer models.
 *
 * @see https://code.claude.com/docs/en/model-config
 */

/** Default Claude family when none is stored / requested. */
export const DEFAULT_CLAUDE_MODEL = 'opus'

/**
 * Shortcuts accepted by /model and schedule CLIs.
 * Values are family aliases passed through to the Agent SDK / Claude Code.
 */
export const CLAUDE_SHORTCUTS: Record<string, string> = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  fable: 'fable',
  best: 'best',
}

/** Provider backends (not Claude family variants). */
export const PROVIDER_ALIASES: Record<string, string> = {
  qwen: 'lmstudio',
  macstudio: 'lmstudio',
  lmstudio: 'lmstudio',
  grok: 'grok',
  xai: 'grok',
  ollama: 'ollama',
  claude: 'claude',
}

/**
 * Normalize a Claude model string to a tracking family alias when possible.
 * Leaves non-Claude provider names and unknown pins alone.
 */
export function normalizeClaudeModel(model: string | undefined | null): string {
  if (!model || model === 'claude') return DEFAULT_CLAUDE_MODEL

  const raw = model.trim()
  const lower = raw.toLowerCase()

  if (CLAUDE_SHORTCUTS[lower]) return CLAUDE_SHORTCUTS[lower]

  // Versioned Anthropic IDs → family (auto-tracks latest)
  if (/^claude-opus(\b|[-[])/i.test(lower) || lower === 'opus') return 'opus'
  if (/^claude-sonnet(\b|[-[])/i.test(lower) || lower === 'sonnet') return 'sonnet'
  if (/^claude-haiku(\b|[-[])/i.test(lower) || lower === 'haiku') return 'haiku'
  if (/^claude-fable(\b|[-[])/i.test(lower) || lower === 'fable') return 'fable'
  if (/^claude-mythos(\b|[-[])/i.test(lower)) return 'best'

  // Strip optional [1m] suffix and re-check
  const base = lower.replace(/\[1m\]$/, '')
  if (base !== lower) return normalizeClaudeModel(base)

  return raw
}

/**
 * Resolve schedule / CLI model arg into the value stored on a task row.
 * - Provider backends: lmstudio | grok | ollama | claude (null means default claude)
 * - Claude families: opus | sonnet | haiku | fable | best (passed to runAgent)
 * - Full IDs: normalized to family when they look like Claude version pins
 */
export function resolveTaskModel(rawModel: string | undefined | null): string | null {
  if (!rawModel) return null
  const lower = rawModel.trim().toLowerCase()
  if (!lower || lower === 'claude') return null

  if (PROVIDER_ALIASES[lower]) {
    const p = PROVIDER_ALIASES[lower]
    return p === 'claude' ? null : p
  }

  if (CLAUDE_SHORTCUTS[lower]) return CLAUDE_SHORTCUTS[lower]

  // Claude version pin → family
  const asClaude = normalizeClaudeModel(rawModel)
  if (asClaude !== rawModel || CLAUDE_SHORTCUTS[asClaude]) {
    // Only treat as Claude if normalize changed it or it's a known family
    if (
      asClaude === 'opus' ||
      asClaude === 'sonnet' ||
      asClaude === 'haiku' ||
      asClaude === 'fable' ||
      asClaude === 'best'
    ) {
      return asClaude
    }
  }

  // Unknown: pass through (e.g. custom ollama model names should not hit this path)
  return lower
}

/** Human label for status / help text. */
export function claudeModelLabel(model: string): string {
  const n = normalizeClaudeModel(model)
  if (CLAUDE_SHORTCUTS[n]) return n
  return model
}

/** Help lines for /model (no version numbers that go stale). */
export const CLAUDE_MODEL_HELP = [
  '/model opus -- latest Claude Opus (complex reasoning)',
  '/model sonnet -- latest Claude Sonnet (daily coding)',
  '/model haiku -- latest Claude Haiku (fast / light)',
  '/model fable -- Claude Fable when available',
  '/model best -- Fable if available, else latest Opus',
].join('\n')
