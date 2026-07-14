#!/usr/bin/env python3
"""
render_marp.py — deck-spec IR → Marp Markdown → HTML/PDF via marp-cli.

Markdown is the most LLM-friendly IR for slides; Marp renders deterministically.
Requires: npx @marp-team/marp-cli (Node) and Chromium for PDF.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

THEME_MAP = {
    "midnight": "default",
    "charcoal": "default",
    "light": "default",
    "coral": "gaia",
    "forest": "gaia",
}


def bullet_line(item: Any) -> str:
    if isinstance(item, dict):
        t = item.get("title") or item.get("heading") or ""
        b = item.get("body") or item.get("text") or ""
        if t and b:
            return f"- **{t}** - {b}"
        return f"- {t or b}"
    return f"- {item}"


def slide_to_md(slide: dict[str, Any]) -> str:
    stype = (slide.get("type") or "content").lower()
    lines: list[str] = []

    if stype == "title":
        lines.append(f"# {slide.get('title') or ''}")
        if slide.get("subtitle"):
            lines.append(f"## {slide['subtitle']}")
        if slide.get("eyebrow"):
            lines.append(f"\n*{slide['eyebrow']}*")
    elif stype == "section":
        lines.append(f"# {slide.get('title') or ''}")
        if slide.get("subtitle"):
            lines.append(f"\n{slide['subtitle']}")
    elif stype == "quote":
        q = slide.get("quote") or ""
        lines.append(f"> {q}")
        if slide.get("attribution"):
            lines.append(f"\n— {slide['attribution']}")
    elif stype == "stats":
        lines.append(f"## {slide.get('title') or ''}")
        lines.append("")
        for st in slide.get("stats") or []:
            lines.append(f"- **{st.get('value', '')}** — {st.get('label', '')}")
    elif stype == "code":
        lines.append(f"## {slide.get('title') or ''}")
        lang = slide.get("language") or ""
        lines.append(f"\n```{lang}\n{slide.get('code') or ''}\n```")
    elif stype in ("two-column", "compare"):
        lines.append(f"## {slide.get('title') or ''}")
        lines.append("")
        if stype == "compare":
            left_h = slide.get("left_title") or "A"
            right_h = slide.get("right_title") or "B"
            left_b = slide.get("left") or []
            right_b = slide.get("right") or []
            if isinstance(left_b, dict):
                left_b = left_b.get("bullets") or []
            if isinstance(right_b, dict):
                right_b = right_b.get("bullets") or []
        else:
            left = slide.get("left") or {}
            right = slide.get("right") or {}
            if isinstance(left, list):
                left = {"bullets": left}
            if isinstance(right, list):
                right = {"bullets": right}
            left_h = left.get("heading") or left.get("title") or "Left"
            right_h = right.get("heading") or right.get("title") or "Right"
            left_b = left.get("bullets") or []
            right_b = right.get("bullets") or []
        lines.append(f"### {left_h}")
        lines.extend(bullet_line(b) for b in left_b)
        lines.append("")
        lines.append(f"### {right_h}")
        lines.extend(bullet_line(b) for b in right_b)
    else:
        lines.append(f"## {slide.get('title') or ''}")
        body = slide.get("body") or slide.get("text")
        if body:
            lines.append(f"\n{body}\n")
        for b in slide.get("bullets") or slide.get("points") or []:
            lines.append(bullet_line(b))

    notes = slide.get("notes")
    if notes:
        lines.append(f"\n<!--\n{notes}\n-->")

    return "\n".join(lines).strip()


def deck_to_marp(deck: dict[str, Any]) -> str:
    theme = THEME_MAP.get(deck.get("theme") or "midnight", "default")
    header = [
        "---",
        "marp: true",
        f'theme: {theme}',
        "paginate: true",
        "size: 16:9",
        f'title: "{(deck.get("title") or "Presentation").replace(chr(34), "")}"',
    ]
    if deck.get("author"):
        header.append(f'author: "{str(deck["author"]).replace(chr(34), "")}"')
    header.append("---\n")
    parts = ["\n".join(header)]
    for slide in deck.get("slides") or []:
        parts.append(slide_to_md(slide))
    return "\n\n---\n\n".join(parts) + "\n"


def find_npx() -> str:
    for p in (
        os.environ.get("NPX"),
        os.path.expanduser("~/.nvm/versions/node/current/bin/npx"),
        "npx",
    ):
        if not p:
            continue
        if p == "npx" or Path(p).exists():
            return p
    return "npx"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("deck", help="Deck JSON path")
    ap.add_argument("--out", required=True, help="Output path prefix (no ext) or full .html/.pdf")
    ap.add_argument("--format", choices=["html", "pdf"], default="html")
    args = ap.parse_args()

    deck = json.loads(Path(args.deck).read_text(encoding="utf-8"))
    md = deck_to_marp(deck)

    out = Path(args.out)
    if out.suffix.lower() in (".html", ".pdf"):
        out_file = out
        md_path = out.with_suffix(".md")
    else:
        out_file = out.with_suffix(f".{args.format}")
        md_path = out.with_suffix(".md")

    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text(md, encoding="utf-8")

    npx = find_npx()
    env = os.environ.copy()
    nvm_bin = os.path.expanduser("~/.nvm/versions/node/current/bin")
    env["PATH"] = f"{nvm_bin}:{env.get('PATH', '')}"

    cmd = [npx, "--yes", "@marp-team/marp-cli", str(md_path), "-o", str(out_file), "--allow-local-files"]
    try:
        subprocess.check_call(cmd, env=env, timeout=120)
    except subprocess.CalledProcessError as e:
        print(f"marp failed: {e}", file=sys.stderr)
        return 1
    except FileNotFoundError:
        print("npx not found — install Node or set PATH", file=sys.stderr)
        return 1

    print("OK")
    print(md_path)
    print(out_file)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
