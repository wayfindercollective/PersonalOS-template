#!/usr/bin/env python3
"""
render_deck.py — THE presentation entry point.

  deck-spec JSON → coerce/validate → HTML + PPTX → Funnel PRESENT_URL

Always prints one JSON object to stdout (agent-parseable).
On success also prints PRESENT_URL=... for Telegram scrapers.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(".")
VALIDATE = ROOT / "scripts/presentation/validate_deck.py"
BUILD = ROOT / "scripts/build-presentation.py"
MARP = ROOT / "scripts/presentation/render_marp.py"
UPLOADS = ROOT / "workspace/uploads"
PRESENTATIONS = ROOT / "workspace/presentations"


def run(cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)


def slugify(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (title or "presentation").lower()).strip("-")
    return (s[:60] or "presentation")


def funnel_host() -> str:
    try:
        raw = subprocess.check_output(["tailscale", "status", "--json"], timeout=3)
        name = (json.loads(raw).get("Self") or {}).get("DNSName") or ""
        return name.rstrip(".") or "your-host.tailnet.ts.net"
    except Exception:
        return "your-host.tailnet.ts.net"


def emit(obj: dict, code: int = 0) -> int:
    print(json.dumps(obj, indent=2, ensure_ascii=False))
    url = obj.get("PRESENT_URL")
    if url:
        print(f"PRESENT_URL={url}")
        print(f"Open on any device: {url}")
    return code


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate + render PersonalOS deck-spec")
    ap.add_argument("deck", nargs="?", help="Path to deck JSON")
    ap.add_argument("--stdin", action="store_true")
    ap.add_argument("--format", default=None, help="html|pptx|both|marp-html|marp-pdf")
    ap.add_argument("--out", help="Output path prefix (no extension)")
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--no-fix", action="store_true")
    args = ap.parse_args()

    try:
        if args.stdin:
            raw_text = sys.stdin.read()
        elif args.deck:
            raw_text = Path(args.deck).read_text(encoding="utf-8")
        else:
            return emit({"ok": False, "stage": "input", "errors": ["Need deck path or --stdin"],
                         "hint": "Pass deck-spec JSON with title + slides[]"}, 2)
        deck_raw = json.loads(raw_text)
    except json.JSONDecodeError as e:
        return emit({
            "ok": False, "stage": "parse",
            "errors": [f"Invalid JSON: {e.msg} (line {e.lineno})"],
            "hint": "Emit valid deck-spec JSON only. No markdown fences, no HTML.",
        }, 1)
    except Exception as e:
        return emit({"ok": False, "stage": "input", "errors": [str(e)]}, 2)

    work = Path("/tmp") / f"pos-deck-{slugify(str(getattr(deck_raw, 'get', lambda k, d=None: d)('title') if isinstance(deck_raw, dict) else 'x'))}"
    if isinstance(deck_raw, dict) and deck_raw.get("title"):
        work = Path("/tmp") / f"pos-deck-{slugify(str(deck_raw['title']))}"
    raw_path = work.with_suffix(".raw.json")
    fixed_path = work.with_suffix(".fixed.json")
    raw_path.write_text(json.dumps(deck_raw, indent=2, ensure_ascii=False), encoding="utf-8")

    vcmd = [sys.executable, str(VALIDATE), str(raw_path), "-o", str(fixed_path), "--json"]
    if args.no_fix:
        vcmd.append("--no-fix")
    else:
        vcmd.append("--fix")
    vr = run(vcmd, timeout=30)
    try:
        vreport = json.loads(vr.stdout or "{}")
    except json.JSONDecodeError:
        return emit({
            "ok": False, "stage": "validate",
            "errors": [vr.stdout or vr.stderr or "validate_deck failed"],
            "hint": "Fix deck-spec JSON and retry.",
        }, 1)

    if not vreport.get("ok"):
        return emit({
            "ok": False,
            "stage": "validate",
            "errors": vreport.get("errors") or ["validation failed"],
            "warnings": vreport.get("warnings") or [],
            "hint": (
                "Fix only the fields in errors, then call create_presentation again (max 3 tries). "
                "Do NOT write HTML or python-pptx. "
                "Rules: types title|section|content|two-column|compare|stats|quote|code; "
                "≤14 slides; ≤6 bullets; each bullet short."
            ),
        }, 1)

    if not fixed_path.exists():
        return emit({"ok": False, "stage": "validate", "errors": ["fixed deck missing after validate"]}, 1)

    fixed = json.loads(fixed_path.read_text(encoding="utf-8"))
    fmt = (args.format or fixed.get("output_format") or "both").lower()
    fixed["output_format"] = fmt
    fixed_path.write_text(json.dumps(fixed, indent=2, ensure_ascii=False), encoding="utf-8")

    out_prefix = Path(args.out) if args.out else UPLOADS / slugify(fixed.get("title") or "presentation")
    out_prefix.parent.mkdir(parents=True, exist_ok=True)

    files: dict[str, str] = {}
    present_url: str | None = None
    errors: list[str] = []

    if fmt in ("html", "pptx", "both"):
        build_fmt = fmt if fmt in ("html", "pptx", "both") else "both"
        bcmd = [
            sys.executable, str(BUILD), str(fixed_path),
            "--format", build_fmt,
            "--out", str(out_prefix),
            "--publish" if not args.no_publish else "--no-publish",
            "--open-hint",
        ]
        br = run(bcmd, timeout=90)
        if br.returncode != 0:
            errors.append(f"render failed: {(br.stderr or br.stdout or '')[:600]}")
        else:
            for line in (br.stdout or "").splitlines():
                line = line.strip()
                if line.startswith("PRESENT_URL="):
                    present_url = line.split("=", 1)[1].strip()
                elif line.endswith(".html") and not line.startswith("local-mirror") and "Open " not in line:
                    # prefer non-mirror path
                    if "local-mirror:" in line:
                        continue
                    path = line.replace("local-mirror:", "").strip()
                    if path.endswith(".html"):
                        files["html"] = path
                elif line.endswith(".pptx"):
                    files["pptx"] = line
                elif line.startswith("local-mirror:"):
                    files["html_mirror"] = line.split(":", 1)[1].strip()

            # Fallbacks if path parsing missed
            html_p = out_prefix.with_suffix(".html")
            pptx_p = out_prefix.with_suffix(".pptx")
            if html_p.exists():
                files.setdefault("html", str(html_p))
            if pptx_p.exists():
                files.setdefault("pptx", str(pptx_p))
            if not present_url and not args.no_publish and html_p.exists():
                PRESENTATIONS.mkdir(parents=True, exist_ok=True)
                dest = PRESENTATIONS / html_p.name
                dest.write_bytes(html_p.read_bytes())
                present_url = f"https://{funnel_host()}/presentations/{dest.name}"
                Path(str(html_p) + ".present-url").write_text(present_url + "\n")

    if fmt in ("marp-html", "marp-pdf"):
        mfmt = "pdf" if fmt == "marp-pdf" else "html"
        marp_out = Path(str(out_prefix) + f".marp.{mfmt}")
        mr = run([
            sys.executable, str(MARP), str(fixed_path),
            "--format", mfmt, "--out", str(marp_out),
        ], timeout=120)
        if mr.returncode != 0:
            errors.append(f"marp failed: {(mr.stderr or mr.stdout or '')[:600]}")
        elif marp_out.exists():
            files["marp"] = str(marp_out)
            if mfmt == "html" and not args.no_publish:
                PRESENTATIONS.mkdir(parents=True, exist_ok=True)
                dest = PRESENTATIONS / marp_out.name
                dest.write_bytes(marp_out.read_bytes())
                up = UPLOADS / marp_out.name
                if up.resolve() != marp_out.resolve():
                    up.write_bytes(marp_out.read_bytes())
                present_url = f"https://{funnel_host()}/presentations/{dest.name}"
                Path(str(up) + ".present-url").write_text(present_url + "\n")
                files["html"] = str(up)

    if errors:
        return emit({
            "ok": False,
            "stage": "render",
            "errors": errors,
            "warnings": vreport.get("warnings") or [],
            "hint": "Renderer error. Fix content if needed and retry once. Do not rewrite scripts.",
        }, 1)

    return emit({
        "ok": True,
        "stage": "done",
        "title": fixed.get("title"),
        "slide_count": len(fixed.get("slides") or []),
        "theme": fixed.get("theme"),
        "format": fmt,
        "files": files,
        "warnings": vreport.get("warnings") or [],
        "PRESENT_URL": present_url,
        "hint": (
            f"Present URL: {present_url}"
            if present_url
            else "Files in workspace/uploads/ (auto-sent on Telegram)."
        ),
    }, 0)


if __name__ == "__main__":
    raise SystemExit(main())
