#!/usr/bin/env python3
"""Generate the Codex distribution of shipflow from the Claude plugin source.

The Claude plugin under plugins/shipflow/ is the single source of truth. Codex reads a
different layout (.agents/plugins/...), invokes skills as `$name` instead of `/name`, has
no `AskUserQuestion`, and dispatches roles through the runtime resolver rather than Claude
agent files. This script performs that translation deterministically:

  skills/<name>/SKILL.md      -> skills/<name>/SKILL.md (+ agents/openai.yaml, Codex banner)
  skills/shared/*.md          -> references/shared/*.md
  agents/*.md                 -> references/roles/*.md   (Claude frontmatter folded into prose)
  hooks/*                     -> references/claude-hooks/* (reference only; not Codex hooks)
  scripts/, schemas/          -> copied verbatim

Usage:
  python3 scripts/generate-codex.py          # (re)write .agents/plugins
  python3 scripts/generate-codex.py --check  # exit 1 if the generated tree is stale

Never edit files under .agents/plugins by hand.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "plugins" / "shipflow"
OUT = ROOT / ".agents" / "plugins"
PLUGIN = "shipflow"

BANNER = """> Codex compatibility: this file is generated from the Claude skill source.
> For worker dispatch, read `../../references/shared/runtime.md` and resolve each role with
> `node ../../scripts/sf-runtime.mjs resolve --host codex --role <role>`; use the returned
> GPT model and effort with Codex collaboration tools. Claude model metadata describes the
> Claude backend only. Set `SF_PLUGIN_ROOT` to this plugin's absolute root before running
> shell examples, and resolve `../` references relative to this SKILL.md. Preserve every
> confirmation gate and destructive-operation guard.
"""


def split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.index("\n---\n", 4)
    meta: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta, text[end + 5 :]


def unquote(v: str) -> str:
    if len(v) >= 2 and v[0] == v[-1] == '"':
        return json.loads(v)
    return v


def translate(text: str, skills: list[str]) -> str:
    names = "|".join(sorted(map(re.escape, skills), key=len, reverse=True))
    text = re.sub(rf"(?<![\w/.$-])/({names})\b", r"$\1", text)
    text = text.replace("${CLAUDE_PLUGIN_ROOT}/skills/shared/", "../../references/shared/")
    text = text.replace("${CLAUDE_PLUGIN_ROOT}/scripts/", "../../scripts/")
    text = text.replace("${CLAUDE_PLUGIN_ROOT}", "${SF_PLUGIN_ROOT}")
    text = re.sub(r"(?<![\w/.])skills/shared/", "../../references/shared/", text)
    text = re.sub(r"`AskUserQuestion`|AskUserQuestion", "the available structured user-input tool", text)
    return text


def title(name: str) -> str:
    return " ".join(w.capitalize() for w in name.split("-"))


def build(dest: Path) -> list[dict]:
    plugin = dest / "plugins" / PLUGIN
    manifest: list[dict] = []
    skill_dirs = sorted(p for p in (SRC / "skills").iterdir() if p.is_dir() and p.name != "shared")
    skills = [p.name for p in skill_dirs]

    for sd in skill_dirs:
        out = plugin / "skills" / sd.name
        out.mkdir(parents=True)
        for f in sorted(sd.rglob("*")):
            if f.is_dir():
                continue
            rel = f.relative_to(sd)
            target = out / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if f.name == "SKILL.md":
                raw = f.read_text()
                meta, body = split_frontmatter(raw)
                desc = unquote(meta.get("description", ""))
                front = f"---\nname: {sd.name}\ndescription: {json.dumps(translate(desc, skills))}\n---\n\n"
                target.write_text(front + BANNER + translate(body, skills))
                manifest.append({
                    "name": sd.name,
                    "source": str(f.relative_to(ROOT)),
                    "sha256": hashlib.sha256(raw.encode()).hexdigest(),
                    "claude_model": meta.get("model", "inherit"),
                })
            elif f.suffix == ".md":
                target.write_text(translate(f.read_text(), skills))
            else:
                shutil.copy2(f, target)
        (out / "agents").mkdir(exist_ok=True)
        (out / "agents" / "openai.yaml").write_text(
            "interface:\n"
            f'  display_name: "{title(sd.name)}"\n'
            f'  short_description: "Run the {title(sd.name)} workflow"\n'
            f'  default_prompt: "Use ${sd.name} to run this workflow."\n\n'
            "policy:\n  allow_implicit_invocation: false\n"
        )

    shared = plugin / "references" / "shared"
    shared.mkdir(parents=True)
    for f in sorted((SRC / "skills" / "shared").glob("*.md")):
        (shared / f.name).write_text(translate(f.read_text(), skills))

    roles = plugin / "references" / "roles"
    roles.mkdir(parents=True)
    for f in sorted((SRC / "agents").glob("*.md")):
        meta, body = split_frontmatter(f.read_text())
        head = (
            f"# {title(f.stem)}\n\n{meta.get('description', '')}\n\n"
            f"Claude backend model: `{meta.get('model', 'inherit')}`, effort `{meta.get('effort', 'session')}`. "
            "Codex dispatch uses the runtime role policy (`../shared/runtime.md`).\n\n"
        )
        (roles / f.name).write_text(head + translate(body, skills).replace("../../references/shared/", "../shared/"))

    hooks = plugin / "references" / "claude-hooks"
    shutil.copytree(SRC / "hooks", hooks, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache"))
    shutil.copytree(SRC / "scripts", plugin / "scripts", ignore=shutil.ignore_patterns("node_modules"))
    shutil.copytree(SRC / "schemas", plugin / "schemas")

    claude_manifest = json.loads((SRC / ".claude-plugin" / "plugin.json").read_text())
    (plugin / ".codex-plugin").mkdir()
    (plugin / ".codex-plugin" / "plugin.json").write_text(json.dumps({
        "name": PLUGIN,
        "version": claude_manifest["version"],
        "description": claude_manifest["description"],
        "author": claude_manifest.get("author", {}),
        "keywords": claude_manifest.get("keywords", []),
    }, indent=2) + "\n")

    (dest / "marketplace.json").write_text(json.dumps({
        "name": PLUGIN,
        "interface": {"displayName": "shipflow"},
        "plugins": [{
            "name": PLUGIN,
            "source": {"source": "local", "path": f"./.agents/plugins/plugins/{PLUGIN}"},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
            "category": "Engineering",
        }],
    }, indent=2) + "\n")
    (dest / "SOURCE_MANIFEST.json").write_text(json.dumps({"skills": manifest}, indent=2) + "\n")
    return manifest


def tree(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts
    }


def main() -> int:
    check = "--check" in sys.argv[1:]
    with tempfile.TemporaryDirectory() as tmp:
        staged = Path(tmp) / "plugins"
        staged.mkdir()
        build(staged)
        if check:
            if not OUT.exists() or tree(staged) != tree(OUT):
                print("Codex distribution is stale: run python3 scripts/generate-codex.py", file=sys.stderr)
                return 1
            print("Codex distribution is up to date.")
            return 0
        if OUT.exists():
            shutil.rmtree(OUT)
        OUT.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(staged, OUT)
    print(f"Wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
