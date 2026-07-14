#!/usr/bin/env python3
"""
validate_deck.py — coerce + schema + guardrails for PersonalOS deck-spec IR.

Design (from local-LLM reliability research):
  - Model only emits content (deck-spec).
  - This script heals structural mess before render (coerce/fix).
  - Hard errors only when the model must rewrite meaning.

Exit: 0 ok, 1 invalid, 2 usage
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any

SCHEMA_PATH = Path("./skills/presentation/deck-schema.json")

MAX_SLIDES = 14
HARD_MAX_SLIDES = 16
MAX_BULLETS = 6
MAX_WORDS_PER_BULLET = 12
MAX_TITLE_WORDS = 12

TYPE_ALIASES = {
    "title": "title",
    "title_slide": "title",
    "cover": "title",
    "opening": "title",
    "section": "section",
    "section_header": "section",
    "chapter": "section",
    "divider": "section",
    "content": "content",
    "bullets": "content",
    "bullet": "content",
    "body": "content",
    "text": "content",
    "list": "content",
    "two-column": "two-column",
    "two_column": "two-column",
    "twocolumn": "two-column",
    "columns": "two-column",
    "compare": "compare",
    "comparison": "compare",
    "vs": "compare",
    "stats": "stats",
    "stat": "stats",
    "metrics": "stats",
    "numbers": "stats",
    "quote": "quote",
    "quotation": "quote",
    "code": "code",
    "snippet": "code",
}

THEME_ALIASES = {
    "dark": "midnight",
    "default": "midnight",
    "navy": "midnight",
    "black": "charcoal",
    "white": "light",
    "bright": "light",
    "red": "coral",
    "green": "forest",
}

BANNED_FILLER = re.compile(
    r"\b(in conclusion|let'?s dive in|in today'?s landscape|delve|tapestry|"
    r"game[- ]changer|leverage synerg|at the end of the day|unlock the power|"
    r"in this presentation|without further ado)\b",
    re.I,
)


def word_count(s: str) -> int:
    return len(re.findall(r"\S+", s or ""))


def trim_words(s: str, max_words: int) -> str:
    words = re.findall(r"\S+", s or "")
    if len(words) <= max_words:
        return (s or "").strip()
    return " ".join(words[:max_words])


def clean_str(s: Any) -> str:
    if s is None:
        return ""
    t = str(s).replace("\u2014", " - ").replace("\u2013", "-").strip()
    t = re.sub(r"[ \t]+", " ", t)
    return t


def bullet_text(item: Any) -> str:
    if isinstance(item, dict):
        t = clean_str(item.get("title") or item.get("heading") or "")
        b = clean_str(item.get("body") or item.get("text") or "")
        return f"{t}: {b}".strip(": ").strip() if (t or b) else ""
    return clean_str(item)


def normalize_bullet(item: Any) -> str:
    """Bullets become plain strings — simplest for models and renderers."""
    return trim_words(bullet_text(item), MAX_WORDS_PER_BULLET)


def normalize_bullets(items: Any) -> list[str]:
    if items is None:
        return []
    if isinstance(items, str):
        # Split on newlines if model dumped a blob
        parts = [p.strip("-• \t") for p in items.splitlines() if p.strip()]
        items = parts or [items]
    if not isinstance(items, list):
        items = [items]
    out = [normalize_bullet(x) for x in items if normalize_bullet(x)]
    return out[:MAX_BULLETS]


def coerce_column(col: Any) -> dict[str, Any]:
    if col is None:
        return {"heading": "", "bullets": []}
    if isinstance(col, list):
        return {"heading": "", "bullets": normalize_bullets(col)}
    if isinstance(col, str):
        return {"heading": "", "bullets": normalize_bullets([col])}
    if not isinstance(col, dict):
        return {"heading": "", "bullets": []}
    return {
        "heading": clean_str(col.get("heading") or col.get("title") or ""),
        "text": clean_str(col.get("text") or col.get("body") or ""),
        "bullets": normalize_bullets(col.get("bullets") or col.get("points") or col.get("items")),
    }


def coerce_slide(raw: Any, index: int, warnings: list[str]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        warnings.append(f"slide[{index}] not an object — dropped")
        return None

    stype_raw = clean_str(raw.get("type") or "content").lower().replace(" ", "_")
    stype = TYPE_ALIASES.get(stype_raw, TYPE_ALIASES.get(stype_raw.replace("-", "_"), None))
    if stype is None:
        # Unknown type → content if it has bullets/title
        if raw.get("bullets") or raw.get("points") or raw.get("title"):
            warnings.append(f"slide[{index}] type '{stype_raw}' → content")
            stype = "content"
        else:
            warnings.append(f"slide[{index}] unknown type '{stype_raw}' — dropped")
            return None

    s: dict[str, Any] = {"type": stype}

    for key in (
        "title", "subtitle", "eyebrow", "body", "text", "notes",
        "quote", "attribution", "code", "language",
        "left_title", "right_title", "layout",
    ):
        if key in raw and raw[key] is not None:
            s[key] = clean_str(raw[key])

    # Per-slide layout variants (renderer enums)
    if s.get("layout"):
        layout = s["layout"].lower()
        if stype == "content" and layout not in ("list", "cards", "numbered", "spotlight"):
            layout_map = {"bullet": "list", "bullets": "list", "card": "cards", "numbers": "numbered", "big": "spotlight"}
            s["layout"] = layout_map.get(layout, "list")
        elif stype == "title" and layout not in ("center", "left", "bold"):
            s["layout"] = {"centred": "center", "start": "left", "hero": "bold"}.get(layout, "center")

    if s.get("title"):
        s["title"] = trim_words(s["title"], MAX_TITLE_WORDS)

    # Prefer body over text
    if s.get("text") and not s.get("body"):
        s["body"] = s.pop("text")
    elif "text" in s:
        s.pop("text", None)

    bullets = raw.get("bullets") or raw.get("points") or raw.get("items")
    if bullets is not None:
        s["bullets"] = normalize_bullets(bullets)

    if stype == "two-column":
        s["left"] = coerce_column(raw.get("left"))
        s["right"] = coerce_column(raw.get("right"))
    if stype == "compare":
        # Renderer expects plain bullet lists + left_title/right_title
        left_c = coerce_column(raw.get("left"))
        right_c = coerce_column(raw.get("right"))
        s["left"] = left_c.get("bullets") or []
        s["right"] = right_c.get("bullets") or []
        s["left_title"] = (
            clean_str(raw.get("left_title") or left_c.get("heading") or "A") or "A"
        )
        s["right_title"] = (
            clean_str(raw.get("right_title") or right_c.get("heading") or "B") or "B"
        )
    if stype == "stats":
        stats_in = raw.get("stats") or raw.get("metrics") or []
        if isinstance(stats_in, dict):
            stats_in = [{"value": k, "label": v} for k, v in stats_in.items()]
        stats = []
        if isinstance(stats_in, list):
            for st in stats_in[:6]:
                if isinstance(st, dict):
                    stats.append({
                        "value": clean_str(st.get("value") or st.get("number") or "")[:24],
                        "label": clean_str(st.get("label") or st.get("name") or "")[:48],
                    })
                elif isinstance(st, (list, tuple)) and len(st) >= 2:
                    stats.append({"value": clean_str(st[0])[:24], "label": clean_str(st[1])[:48]})
        s["stats"] = [x for x in stats if x["value"] or x["label"]]

    if stype == "quote" and not s.get("quote"):
        s["quote"] = clean_str(raw.get("text") or raw.get("body") or raw.get("title") or "")

    if stype == "code" and not s.get("code"):
        s["code"] = clean_str(raw.get("body") or raw.get("text") or "")

    # Content with no bullets but has body is fine; empty content → drop later if empty
    if stype == "content" and not s.get("bullets") and not s.get("body"):
        if s.get("title") and not s.get("subtitle"):
            # Single-line title-only content → keep as section-like content
            pass

    blob = json.dumps(s, ensure_ascii=False)
    if BANNED_FILLER.search(blob):
        warnings.append(f"slide[{index}] AI-filler phrasing — consider rewrite")

    return s


def coerce_deck(raw: Any) -> tuple[dict[str, Any], list[str]]:
    """Heal structural mess so local models succeed on first try more often."""
    warnings: list[str] = []

    if isinstance(raw, list):
        # Model returned slides array only
        raw = {"title": "Presentation", "slides": raw}
        warnings.append("Root was array → wrapped as slides")

    if not isinstance(raw, dict):
        return {"title": "Presentation", "slides": []}, ["Deck must be a JSON object"]

    d: dict[str, Any] = {}
    d["title"] = clean_str(raw.get("title") or raw.get("name") or "Presentation") or "Presentation"
    d["author"] = clean_str(raw.get("author") or "")
    d["subtitle"] = clean_str(raw.get("subtitle") or raw.get("tagline") or "")

    theme = clean_str(raw.get("theme") or "midnight").lower()
    theme = THEME_ALIASES.get(theme, theme)
    if theme not in ("midnight", "charcoal", "light", "coral", "forest"):
        warnings.append(f"theme '{theme}' → midnight")
        theme = "midnight"
    d["theme"] = theme

    # Creative packs (constrained enums — renderer owns the CSS)
    brand = clean_str(raw.get("brand") or "personalos").lower()
    brand_aliases = {"pos": "personalos", "wf": "wayfinder", "wfbot": "wayfinder", "off": "none"}
    d["brand"] = brand_aliases.get(brand, brand if brand in ("personalos", "wayfinder", "none") else "personalos")
    if brand not in ("personalos", "wayfinder", "none") and brand not in brand_aliases:
        if raw.get("logo") or raw.get("logo_path"):
            d["brand"] = "personalos"  # custom logo path still works
        warnings.append(f"brand '{brand}' → {d['brand']}")

    if raw.get("logo") or raw.get("logo_path"):
        d["logo"] = clean_str(raw.get("logo") or raw.get("logo_path"))
    if raw.get("logo_text") or raw.get("brand_text"):
        d["logo_text"] = clean_str(raw.get("logo_text") or raw.get("brand_text"))
    if raw.get("show_logo") is not None:
        d["show_logo"] = bool(raw.get("show_logo"))

    motif = clean_str(raw.get("motif") or "orbs").lower()
    motif_aliases = {"default": "orbs", "dots": "orbs", "glow": "aurora", "lines": "grid"}
    motif = motif_aliases.get(motif, motif)
    d["motif"] = motif if motif in ("orbs", "mesh", "grid", "bars", "aurora", "none") else "orbs"

    vibe = clean_str(raw.get("vibe") or raw.get("style") or "keynote").lower()
    vibe_aliases = {"exec": "keynote", "executive": "keynote", "tech": "technical", "dev": "technical", "loud": "bold"}
    vibe = vibe_aliases.get(vibe, vibe)
    d["vibe"] = vibe if vibe in ("keynote", "product", "technical", "bold") else "keynote"

    accent = clean_str(raw.get("accent") or "default").lower()
    d["accent"] = accent if accent in ("electric", "amber", "mint", "rose", "violet", "default") else "default"

    fmt = clean_str(raw.get("output_format") or raw.get("format") or "both").lower()
    fmt_map = {
        "html": "html", "pptx": "pptx", "ppt": "pptx", "powerpoint": "pptx",
        "both": "both", "all": "both",
        "marp": "marp-html", "marp-html": "marp-html", "marp-pdf": "marp-pdf",
    }
    d["output_format"] = fmt_map.get(fmt, "both")
    if fmt not in fmt_map:
        warnings.append(f"output_format '{fmt}' → both")

    slides_in = raw.get("slides") or raw.get("deck") or raw.get("pages") or []
    if isinstance(slides_in, dict):
        slides_in = list(slides_in.values())
    if not isinstance(slides_in, list):
        slides_in = []

    if len(slides_in) > HARD_MAX_SLIDES:
        warnings.append(f"Truncated slides {len(slides_in)} → {HARD_MAX_SLIDES}")
        slides_in = slides_in[:HARD_MAX_SLIDES]
    elif len(slides_in) > MAX_SLIDES:
        warnings.append(f"Truncated slides {len(slides_in)} → {MAX_SLIDES}")
        slides_in = slides_in[:MAX_SLIDES]

    slides: list[dict[str, Any]] = []
    for i, raw_s in enumerate(slides_in):
        fixed = coerce_slide(raw_s, i, warnings)
        if fixed:
            slides.append(fixed)

    d["slides"] = slides
    return d, warnings


def semantic_errors(deck: dict[str, Any]) -> list[str]:
    """Errors that auto-fix cannot invent meaning for."""
    errors: list[str] = []
    if not clean_str(deck.get("title")):
        errors.append("title is required")
    slides = deck.get("slides") or []
    if not slides:
        errors.append("slides must be a non-empty array")
        return errors

    for i, s in enumerate(slides):
        stype = s.get("type")
        if stype in ("title", "section", "content", "two-column", "compare", "stats", "code"):
            if not clean_str(s.get("title")) and stype != "quote":
                # title slide needs title
                if stype in ("title", "section", "content", "stats", "code", "two-column", "compare"):
                    errors.append(f"slide[{i}] ({stype}): title is required")
        if stype == "content":
            if not (s.get("bullets") or s.get("body")):
                errors.append(f"slide[{i}] content: needs bullets or body")
        if stype == "stats" and not s.get("stats"):
            errors.append(f"slide[{i}] stats: needs stats[] with value+label")
        if stype == "quote" and not clean_str(s.get("quote")):
            errors.append(f"slide[{i}] quote: needs quote text")
        if stype == "code" and not clean_str(s.get("code")):
            errors.append(f"slide[{i}] code: needs code")
        if stype == "compare":
            left_b = s.get("left") if isinstance(s.get("left"), list) else []
            right_b = s.get("right") if isinstance(s.get("right"), list) else []
            if not left_b and not right_b:
                errors.append(f"slide[{i}] compare: left/right need bullets")
    return errors


def schema_validate(deck: dict[str, Any]) -> list[str]:
    """Optional jsonschema pass; keep errors short."""
    try:
        from jsonschema import Draft202012Validator
    except ImportError:
        return []
    if not SCHEMA_PATH.exists():
        return []
    try:
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        validator = Draft202012Validator(schema)
        errs = []
        for err in sorted(validator.iter_errors(deck), key=lambda e: list(e.absolute_path)):
            path = ".".join(str(p) for p in err.absolute_path) or "(root)"
            # Skip noisy additionalProperties if we already coerced
            if "additionalProperties" in err.message:
                continue
            errs.append(f"{path}: {err.message}")
        return errs[:20]
    except Exception as e:
        return [f"schema engine error: {e}"]


def process(raw: Any, fix: bool = True) -> tuple[dict[str, Any], dict[str, Any]]:
    warnings: list[str] = []
    if fix:
        deck, warnings = coerce_deck(raw)
    else:
        deck = raw if isinstance(raw, dict) else {"title": "", "slides": []}
        deck, w2 = coerce_deck(deck)  # still light-clean types
        warnings.extend(w2)

    errors = semantic_errors(deck)
    # Schema after coerce should almost always pass; still check
    if not errors:
        errors.extend(schema_validate(deck))

    report = {
        "ok": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "slide_count": len(deck.get("slides") or []),
        "title": deck.get("title"),
        "theme": deck.get("theme"),
        "output_format": deck.get("output_format"),
    }
    return deck, report


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate/coerce PersonalOS deck-spec")
    ap.add_argument("deck", nargs="?", help="Path to deck JSON")
    ap.add_argument("--stdin", action="store_true")
    ap.add_argument("--fix", action="store_true", default=True,
                    help="Coerce/normalize (default on)")
    ap.add_argument("--no-fix", action="store_true", help="Disable coercion")
    ap.add_argument("-o", "--output", help="Write fixed deck JSON")
    ap.add_argument("--json", action="store_true", help="Machine report (default when -o)")
    ap.add_argument("--print-deck", action="store_true", help="Print fixed deck to stdout")
    args = ap.parse_args()
    do_fix = not args.no_fix

    try:
        if args.stdin:
            raw_text = sys.stdin.read()
        elif args.deck:
            raw_text = Path(args.deck).read_text(encoding="utf-8")
        else:
            print(json.dumps({"ok": False, "errors": ["Provide deck path or --stdin"]}))
            return 2
        raw = json.loads(raw_text)
    except Exception as e:
        print(json.dumps({"ok": False, "errors": [f"JSON parse error: {e}"], "stage": "parse"}))
        return 2

    deck, report = process(raw, fix=do_fix)

    if args.output and report["ok"]:
        Path(args.output).write_text(json.dumps(deck, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        report["written"] = args.output
    elif args.output and not report["ok"] and do_fix:
        # Still write best-effort fixed deck for debugging
        Path(args.output).write_text(json.dumps(deck, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        report["written"] = args.output

    if args.print_deck and report["ok"]:
        print(json.dumps(deck, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(report, indent=2, ensure_ascii=False))

    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
