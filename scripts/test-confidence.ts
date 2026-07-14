/**
 * Test confidence scoring with various question types.
 * Run: tsx scripts/test-confidence.ts
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434'
const MODEL = 'qwen3.5:9b-q8_0-256k'

// --- Same pattern matching logic as ollama.ts ---

const CANT_ANSWER_PATTERNS = [
  /\bi\s+(don'?t|do not|cannot|can'?t)\s+\w*\s*(know|answer|access|provide|determine|tell|see|view|check|verify|confirm)/i,
  /\bi\s+don'?t\s+have\s+(access|information|data|the ability|a way)/i,
  /\bi'?m\s+(not\s+sure|unable|not\s+able|afraid\s+i|sorry)/i,
  /\bi\s+lack\s+(access|information|the\s+ability|data)/i,
  /\bas\s+an?\s+ai\b/i,
  /\bbeyond\s+(my|what\s+i)\b/i,
  /\bi\s+have\s+no\s+(way|access|ability|information|data|means)\b/i,
  /\bthis\s+is\s+(beyond|outside)\s+(my|what)\b/i,
  /\bnot\s+(publicly\s+documented|available\s+to\s+me|something\s+i\s+can)/i,
  /\bi\s+would\s+need\s+(access|more\s+information|to\s+check|to\s+see|to\s+verify)/i,
  /\bwithout\s+(access|more\s+context|additional\s+information)/i,
  /\bcannot\s+(access|determine|verify|confirm|check|browse|search)/i,
  /\bhas\s+not\s+(happened|occurred|taken\s+place|been\s+(held|played|announced))/i,
  /\bhasn'?t\s+(happened|occurred|taken\s+place|been)/i,
  /\bnot\s+(yet|happened\s+yet)\b/i,
  /\bin\s+the\s+future\b/i,
  /\bmy\s+(training|knowledge)\s+(data|cutoff|only\s+goes)/i,
  /\bdon'?t\s+have\s+(real-?time|current|live|up-?to-?date)\s+(data|information|access|prices?)/i,
  /\bcurrent\s+price\b.*\bcannot\b/i,
  /\bi\s+(can'?t|cannot)\s+(browse|search|look\s+up|fetch|access\s+the\s+internet)/i,
  /\bi'?m\s+not\s+(entirely\s+)?certain\b/i,
  /\bthis\s+may\s+(not\s+be|be\s+in)accurate\b/i,
  /\bplease\s+(verify|check|confirm)\s+(this|these|with)\b/i,
  /\bi\s+recommend\s+(checking|verifying|confirming)\b/i,
  /\byou\s+should\s+(verify|check|confirm|consult)\b/i,
]

const HEDGING_PATTERNS = [
  /\bgenerally\s+speaking\b/i,
  /\bit\s+depends\s+on\b.*\bit\s+depends\s+on\b/is,
  /\bthere\s+are\s+many\s+(factors|variables|considerations)\b/i,
  /\bthis\s+is\s+a\s+(complex|complicated|nuanced|broad)\s+(topic|question|issue|area)\b/i,
  /\bit'?s\s+(hard|difficult)\s+to\s+(say|give|provide)\s+(a\s+)?(definitive|exact|specific)/i,
  /\bthe\s+answer\s+(depends|varies|is\s+not\s+straightforward)\b/i,
]

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

function normalizeQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"')
}

function evaluateConfidence(rawResponse: string): { score: number; reason: string } {
  const response = normalizeQuotes(rawResponse)
  const trimmed = response.trim()

  if (trimmed.length > 0 && trimmed.length < 30 && /^\d|^yes|^no|^true|^false|^[A-Z][a-z]+\.?$/i.test(trimmed)) {
    return { score: 90, reason: 'Direct answer' }
  }
  if (trimmed.length < 3) {
    return { score: 10, reason: 'Empty response' }
  }

  for (const pattern of CANT_ANSWER_PATTERNS) {
    if (pattern.test(response)) {
      return { score: 15, reason: 'Model cannot answer this' }
    }
  }

  let hedgeCount = 0
  for (const pattern of HEDGING_PATTERNS) {
    if (pattern.test(response)) hedgeCount++
  }

  if (hedgeCount >= 2 && response.length < 500) {
    return { score: 35, reason: 'Response is mostly hedging' }
  }
  if (hedgeCount >= 1 && response.length < 200) {
    return { score: 50, reason: 'Vague short response' }
  }
  if (trimmed.length < 30) {
    return { score: 50, reason: 'Response too brief' }
  }

  return { score: 90, reason: 'Response looks complete' }
}

// --- Test cases ---

const TEST_CASES = [
  // Should KEEP (useful answers)
  { label: 'Basic math', question: 'What is 2 + 2?', expect: 'KEEP' },
  { label: 'Capital', question: 'What is the capital of France?', expect: 'KEEP' },
  { label: 'Coding task', question: 'Write a Python function to reverse a string', expect: 'KEEP' },

  // Should ESCALATE (can't answer)
  { label: 'Personal', question: 'What did I have for breakfast today?', expect: 'ESCALATE' },
  { label: 'Private data', question: 'What is my bank account balance?', expect: 'ESCALATE' },
  { label: 'Real-time', question: 'What is the current price of Bitcoin right now?', expect: 'ESCALATE' },
]

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

async function askOllama(question: string): Promise<string> {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Chicago',
  })
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `Today is ${today}. Be concise. If unsure about a fact, say so instead of guessing.`,
        },
        { role: 'user', content: question },
      ],
      stream: false,
      options: { num_predict: 4096 },
    }),
    signal: AbortSignal.timeout(120_000),
  })
  const data = (await res.json()) as { message?: { content: string } }
  const raw = data.message?.content ?? '(no response)'
  return stripThinkTags(raw)
}

async function main() {
  console.log(`\n${BOLD}Confidence Scoring Test (v3 -- pure pattern matching)${RESET}`)
  console.log(`Model: ${MODEL} @ ${OLLAMA_URL}`)
  console.log(`Threshold: 80% (below = escalate to Claude Code)`)
  console.log('─'.repeat(80))

  let correct = 0
  let total = 0

  for (const tc of TEST_CASES) {
    total++
    process.stdout.write(`\n${BOLD}[${tc.label}]${RESET} ${tc.question}\n`)
    process.stdout.write('  Asking... ')

    const response = await askOllama(tc.question)
    const preview = response.replace(/\n/g, ' ').slice(0, 100)
    console.log('done')
    console.log(`  ${DIM}${preview}...${RESET}`)

    const { score, reason } = evaluateConfidence(response)

    const action = score >= 80 ? 'KEEP' : 'ESCALATE'
    const color = score >= 80 ? GREEN : score >= 50 ? YELLOW : RED
    const match = action === tc.expect
    if (match) correct++

    const matchIndicator = match ? `${GREEN}✓${RESET}` : `${RED}✗ (expected ${tc.expect})${RESET}`

    console.log(`  ${color}${score}%${RESET} ${reason}`)
    console.log(`  → ${action} ${matchIndicator}`)
  }

  console.log('\n' + '─'.repeat(80))
  const pct = Math.round((correct / total) * 100)
  const color = pct >= 80 ? GREEN : pct >= 60 ? YELLOW : RED
  console.log(`${BOLD}Results: ${color}${correct}/${total} correct (${pct}%)${RESET}\n`)
}

main().catch(console.error)
