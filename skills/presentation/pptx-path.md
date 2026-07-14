# PPTX path (editable PowerPoint)

## Default: deterministic python-pptx from deck-spec

The model does **not** write python-pptx code.  
`build-presentation.py` maps slide types onto a fixed layout:

| type | PPTX layout behavior |
|------|----------------------|
| title / section | Large title + subtitle |
| content | Title + bullets |
| two-column / compare | Two bullet columns |
| stats | Value/label cards |
| quote | Large quote + attribution |
| code | Monospace block |

```bash
python3 ./scripts/presentation/render_deck.py deck.json --format pptx
# or both (HTML Funnel link + PPTX file)
python3 .../render_deck.py deck.json --format both
```

## Why template-style mapping

Build-from-scratch LLM pptx code is the main failure mode for local models.  
Keeping layout in the script and content in JSON is the reliability win.

## Notes

- Default Marp/Slidev PPTX export is often image-based (not editable). Prefer this path for true editable text.  
- Files land in `workspace/uploads/` and auto-send on Telegram.
