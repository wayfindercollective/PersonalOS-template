# HTML path (open on any device)

## Default: PersonalOS renderer + Funnel

`render_deck.py` / `create_presentation` with `output_format: "html"` or `"both"`:

1. Validates deck-spec  
2. Renders self-contained HTML (`scripts/build-presentation.py`)  
3. Mirrors to `workspace/presentations/`  
4. Sets PRESENT_URL (local http://127.0.0.1:PORT/presentations/... or your PRESENTATION_FUNNEL_HOST)

Funnel edge (`src/presentations.ts` on :8787) serves that path with correct `text/html` and proxies other routes to Whisper.

**Present:** tap PRESENT_URL → browser → arrows/space. No third-party host.

If Funnel points at the wrong port:

```bash
bash ./scripts/enable-presentation-funnel.sh
```

## Marp path (Markdown-native)

When you want Marp CLI determinism:

```json
{ "output_format": "marp-html", "title": "...", "slides": [ ... ] }
```

```bash
python3 ./scripts/presentation/render_deck.py deck.json --format marp-html
```

Pipeline: deck-spec → Marp Markdown → `npx @marp-team/marp-cli` → HTML (and optional PDF with `marp-pdf`).

Marp is the most LLM-friendly slide format; use it when PersonalOS HTML themes are not required.

## Themes (PersonalOS HTML)

`midnight` (default) | `charcoal` | `light` | `coral` | `forest`
