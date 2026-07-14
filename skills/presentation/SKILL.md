---
name: presentation
description: >
  Build slide decks for PersonalOS (HTML Funnel link + PPTX). Triggers: presentation,
  slides, deck, powerpoint, pptx, pitch, demo deck. Emit deck-spec JSON only; scripts
  validate and render. Never free-form HTML or python-pptx.
---

# Presentation

## One rule

**You decide content. Scripts render.**

```
deck-spec JSON → coerce/validate → HTML + PPTX → PRESENT_URL (Funnel)
```

## Default action

**Qwen / LM Studio:** call `create_presentation` with `title` + `slides`.  
**Claude / shell:** 

```bash
python3 ./scripts/presentation/render_deck.py deck.json
```

On success, tell the user the **PRESENT_URL** (tap on any phone/laptop). Files also auto-send from `workspace/uploads/`.

## Deck-spec (only format you write)

```json
{
  "title": "Local Models That Work",
  "author": "Your Name",
  "theme": "midnight",
  "slides": [
    { "type": "title", "title": "Local Models That Work", "subtitle": "PersonalOS demo" },
    { "type": "stats", "title": "The stack", "stats": [
      { "value": "397B", "label": "params" },
      { "value": "0", "label": "cloud required" }
    ]},
    { "type": "content", "title": "Why local", "bullets": [
      "Privacy for real work",
      "Tools that act, not just chat",
      "You own the stack"
    ]},
    { "type": "compare", "title": "Cloud vs local",
      "left_title": "Cloud chat", "left": ["Answers in a box", "Context dies"],
      "right_title": "PersonalOS", "right": ["Tools that act", "Memory persists"]
    },
    { "type": "title", "title": "Questions", "subtitle": "Built on PersonalOS" }
  ]
}
```

### Slide types (enum only)

| type | required fields |
|------|-----------------|
| `title` | title, optional subtitle/eyebrow |
| `section` | title |
| `content` | title + bullets (or body) |
| `two-column` | title + left/right `{heading, bullets}` |
| `compare` | title + left_title/right_title + left/right bullet arrays |
| `stats` | title + stats `[{value, label}]` |
| `quote` | quote, optional attribution |
| `code` | title + code |

### Guardrails (auto-healed when possible)

- ≤14 slides (hard 16)
- ≤6 bullets, short (~12 words) — **trimmed automatically**
- Type aliases coerced (`bullets`→`content`, `dark`→`midnight`, …)
- Em dashes stripped
- **You still fix** empty content, missing quote text, empty stats

### Design knobs (creative, still constrained)

Model picks **enums** — renderer owns the look. No free-form CSS.

| Field | Options | Default |
|-------|---------|---------|
| `theme` | midnight, charcoal, light, coral, forest | midnight |
| `brand` | personalos, none (or add your own brand assets) | personalos |
| `logo` | path or URL (optional override) | brand mark |
| `logo_text` | wordmark string | PersonalOS |
| `motif` | orbs, mesh, grid, bars, aurora, none | orbs |
| `vibe` | keynote, product, technical, bold | keynote |
| `accent` | default, electric, amber, mint, rose, violet | default |

Per-slide optional `layout`:
- **content:** `list` \| `cards` \| `numbered` \| `spotlight`
- **title:** `center` \| `left` \| `bold`

Example spice:

```json
{
  "theme": "midnight",
  "brand": "personalos",
  "motif": "aurora",
  "vibe": "bold",
  "accent": "electric",
  "slides": [
    { "type": "title", "layout": "bold", "title": "...", "subtitle": "..." },
    { "type": "content", "layout": "cards", "title": "...", "bullets": ["...", "..."] },
    { "type": "content", "layout": "numbered", "title": "...", "bullets": ["...", "..."] }
  ]
}
```

## Self-correction (max 3)

1. Call `create_presentation`  
2. If `ok: false` → fix **only** listed errors → retry  
3. If `ok: true` → give the user `PRESENT_URL`  
4. Never hand-write HTML or python-pptx

## Delivery

- **Primary:** `https://your-host.tailnet.ts.net/presentations/NAME.html`  
- Also `.html` + `.pptx` in uploads (Telegram auto-send)  
- Funnel setup once: `scripts/enable-presentation-funnel.sh`

## Optional reading

- `deck-schema.json` — formal schema  
- `html-path.md` / `pptx-path.md` — path details  
- `qa.md` — visual polish pass  
- `examples/valid-deck.json` — full example  

## Do not

- Multi-file HTML across tool loops  
- Invent new slide types  
- Dump whole skill helpers into context  
- Say you cannot send files  
