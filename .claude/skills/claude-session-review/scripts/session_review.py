#!/usr/bin/env python3
"""
Reads ~/.claude/projects/<project-slug>/*.jsonl and outputs a change report.
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


def get_project_slug(cwd: str) -> str:
    return cwd.replace("/", "-").replace(".", "-").lstrip("-")


def find_project_dir(cwd: str) -> "Path | None":
    projects_root = Path.home() / ".claude" / "projects"
    slug = get_project_slug(cwd)
    candidate = projects_root / slug
    if candidate.exists():
        return candidate
    # Fallback: search by suffix match (handles edge cases)
    suffix = cwd.split("/")[-1]
    for d in projects_root.iterdir():
        if d.is_dir() and d.name.endswith(suffix.replace(".", "-")):
            if any(part.replace(".", "-") in d.name for part in cwd.split("/")[-3:]):
                return d
    return None


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--hours", type=int, help="Last N hours")
    p.add_argument("--days", type=int, help="Last N days")
    p.add_argument("--since", help="ISO date/datetime e.g. 2026-04-27 or 2026-04-27T10:00")
    p.add_argument("--until", help="ISO date/datetime (default: now)")
    p.add_argument("--project", help="Project CWD path (default: current dir)")
    p.add_argument("--output", help="Output file path (default: docs/agent-changes/claude-YYYY-MM-DD.md)")
    p.add_argument("--print", action="store_true", help="Print report to stdout instead of file")
    return p.parse_args()


def parse_ts(s: str) -> datetime:
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    raise ValueError(f"Cannot parse timestamp: {s}")


def load_sessions(project_dir: Path, since: datetime, until: datetime):
    sessions = []
    for f in sorted(project_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime):
        turns = parse_jsonl(f, since, until)
        if turns:
            sessions.append({"file": f.stem, "turns": turns})
    return sessions


def parse_jsonl(path: Path, since: datetime, until: datetime):
    turns = []
    current_turn = None

    try:
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return []

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        ts_str = obj.get("timestamp", "")
        ts = None
        if ts_str:
            try:
                ts = parse_ts(ts_str)
            except ValueError:
                pass

        msg_type = obj.get("type")

        # New user turn (external human message)
        if msg_type == "user" and obj.get("userType") == "external":
            if ts and not (since <= ts <= until):
                continue
            msg = obj.get("message", {})
            content = msg.get("content", "")
            text = ""
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        text = c.get("text", "")
                        break
            text = text.strip()
            # Skip internal/system-injected messages
            if text.startswith("This session is being continued") or not text:
                continue
            current_turn = {
                "ts": ts,
                "prompt": text[:300],
                "files_edited": [],
                "files_written": [],
                "bash_descriptions": [],
            }
            turns.append(current_turn)

        # Assistant turn with tool calls
        elif msg_type == "assistant" and current_turn is not None:
            content = obj.get("message", {}).get("content", [])
            if not isinstance(content, list):
                continue
            for item in content:
                if not isinstance(item, dict) or item.get("type") != "tool_use":
                    continue
                name = item.get("name", "")
                inp = item.get("input", {})
                if name == "Edit":
                    fp = inp.get("file_path", "")
                    if fp:
                        current_turn["files_edited"].append(fp)
                elif name == "Write":
                    fp = inp.get("file_path", "")
                    if fp:
                        current_turn["files_written"].append(fp)
                elif name == "Bash":
                    desc = inp.get("description", "")
                    cmd = inp.get("command", "")
                    if desc:
                        current_turn["bash_descriptions"].append(desc[:120])
                    elif cmd and ("git commit" in cmd or "git push" in cmd or "npm" in cmd or "pnpm" in cmd):
                        current_turn["bash_descriptions"].append(cmd[:80])

    return turns


def shorten_path(fp: str, cwd: str) -> str:
    try:
        return os.path.relpath(fp, cwd)
    except ValueError:
        return fp


def build_report(sessions, since: datetime, until: datetime, cwd: str) -> str:
    total_files = set()
    for s in sessions:
        for turn in s["turns"]:
            total_files.update(turn["files_edited"] + turn["files_written"])

    lines = []
    lines.append("# Claude Session Changes Report")
    lines.append("")
    lines.append(f"**Time Range**: {since.astimezone().strftime('%Y-%m-%d %H:%M')} → {until.astimezone().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"**Sessions**: {len(sessions)}")
    lines.append(f"**Turns**: {sum(len(s['turns']) for s in sessions)}")
    lines.append(f"**Files Touched**: {len(total_files)}")
    lines.append("")
    lines.append("---")

    for idx, sess in enumerate(sessions, 1):
        if not sess["turns"]:
            continue
        first_ts = sess["turns"][0]["ts"]
        ts_str = first_ts.astimezone().strftime("%Y-%m-%d %H:%M") if first_ts else "unknown"
        lines.append("")
        lines.append(f"## Session {idx} — {ts_str}")
        lines.append("")

        # Collect all files for this session
        sess_edited = defaultdict(int)
        sess_written = set()
        for turn in sess["turns"]:
            for fp in turn["files_edited"]:
                sess_edited[fp] += 1
            sess_written.update(turn["files_written"])

        lines.append("**Turns:**")
        for t_idx, turn in enumerate(sess["turns"], 1):
            ts = turn["ts"].astimezone().strftime("%H:%M") if turn["ts"] else "??"
            prompt = turn["prompt"].replace("\n", " ")
            lines.append(f"{t_idx}. `{ts}` {prompt}")
        lines.append("")

        if sess_edited or sess_written:
            lines.append("**Files Modified:**")
            for fp, cnt in sorted(sess_edited.items(), key=lambda x: x[0]):
                short = shorten_path(fp, cwd)
                suffix = f" ×{cnt}" if cnt > 1 else ""
                lines.append(f"- `{short}`{suffix}")
            for fp in sorted(sess_written):
                short = shorten_path(fp, cwd)
                if fp not in sess_edited:
                    lines.append(f"- `{short}` (new)")
            lines.append("")

        bash_all = []
        for turn in sess["turns"]:
            bash_all.extend(turn["bash_descriptions"])
        # Deduplicate, keep only meaningful ones
        seen = set()
        key_bash = []
        for b in bash_all:
            if b not in seen:
                seen.add(b)
                key_bash.append(b)
        if key_bash:
            lines.append("**Key Actions:**")
            for b in key_bash[:10]:
                lines.append(f"- {b}")
            lines.append("")

    if total_files:
        lines.append("---")
        lines.append("")
        lines.append("## All Files Touched")
        lines.append("")
        for fp in sorted(total_files):
            short = shorten_path(fp, cwd)
            lines.append(f"- `{short}`")

    lines.append("")
    lines.append(f"*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*")
    return "\n".join(lines)


def main():
    args = parse_args()
    now = datetime.now(timezone.utc)
    cwd = args.project or os.getcwd()

    # Resolve time range
    if args.since:
        since_str = args.since
        if "T" not in since_str:
            since_str += "T00:00:00"
        since = datetime.fromisoformat(since_str).astimezone(timezone.utc)
    elif args.hours:
        since = now - timedelta(hours=args.hours)
    elif args.days:
        since = now - timedelta(days=args.days)
    else:
        # Default: today
        today = now.astimezone()
        since = today.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)

    if args.until:
        until_str = args.until
        if "T" not in until_str:
            until_str += "T23:59:59"
        until = datetime.fromisoformat(until_str).astimezone(timezone.utc)
    else:
        until = now

    project_dir = find_project_dir(cwd)

    if not project_dir:
        slug = get_project_slug(cwd)
        print(f"No Claude sessions found for project: {cwd}", file=sys.stderr)
        print(f"Expected: {Path.home() / '.claude' / 'projects' / slug}", file=sys.stderr)
        sys.exit(1)

    sessions = load_sessions(project_dir, since, until)

    if not sessions:
        print(f"No sessions found in time range {since.isoformat()} → {until.isoformat()}")
        sys.exit(0)

    report = build_report(sessions, since, until, cwd)

    if args.print:
        print(report)
        return

    # Write to docs/agent-changes/
    if args.output:
        out_path = Path(args.output)
    else:
        date_str = now.astimezone().strftime("%Y-%m-%d")
        out_dir = Path(cwd) / "docs" / "agent-changes"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"claude-{date_str}.md"

    out_path.write_text(report, encoding="utf-8")
    print(f"Report written to: {out_path}")
    print(f"Sessions: {len(sessions)} | Turns: {sum(len(s['turns']) for s in sessions)}")


if __name__ == "__main__":
    main()
