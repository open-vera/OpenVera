#!/usr/bin/env python3
"""
Unified agent changes report: combines Claude Code + Cursor + git log.
Outputs markdown to docs/agent-changes/report-YYYY-MM-DD.md
"""
import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional


# ── helpers ──────────────────────────────────────────────────────────────────

def parse_ts_iso(s: str) -> datetime:
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    raise ValueError(f"Cannot parse: {s}")


def shorten_path(fp: str, cwd: str) -> str:
    try:
        return os.path.relpath(fp, cwd)
    except ValueError:
        return fp


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--hours", type=int)
    p.add_argument("--days", type=int)
    p.add_argument("--since", help="e.g. 2026-04-27 or 2026-04-27T10:00")
    p.add_argument("--until")
    p.add_argument("--project", help="Project CWD (default: cwd)")
    p.add_argument("--output")
    p.add_argument("--print", action="store_true")
    return p.parse_args()


# ── Claude Code sessions ──────────────────────────────────────────────────────

def _get_claude_project_dir(cwd: str) -> Optional[Path]:
    slug = cwd.replace("/", "-").replace(".", "-").lstrip("-")
    projects_root = Path.home() / ".claude" / "projects"
    candidate = projects_root / slug
    if candidate.exists():
        return candidate
    suffix = cwd.split("/")[-1].replace(".", "-")
    for d in projects_root.iterdir():
        if d.is_dir() and d.name.endswith(suffix):
            if any(p.replace(".", "-") in d.name for p in cwd.split("/")[-3:]):
                return d
    return None


def load_claude_sessions(cwd: str, since: datetime, until: datetime):
    project_dir = _get_claude_project_dir(cwd)
    if not project_dir:
        return []

    sessions = []
    for f in sorted(project_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime):
        turns = _parse_claude_jsonl(f, since, until)
        if turns:
            sessions.append({"source": "claude", "file": f.stem, "turns": turns})
    return sessions


def _parse_claude_jsonl(path: Path, since: datetime, until: datetime):
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

        ts = None
        ts_str = obj.get("timestamp", "")
        if ts_str:
            try:
                ts = parse_ts_iso(ts_str)
            except ValueError:
                pass

        if obj.get("type") == "user" and obj.get("userType") == "external":
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
            if text.startswith("This session is being continued") or not text:
                continue
            current_turn = {
                "ts": ts,
                "prompt": text[:300],
                "files_edited": [],
                "files_written": [],
                "actions": [],
            }
            turns.append(current_turn)

        elif obj.get("type") == "assistant" and current_turn is not None:
            content = obj.get("message", {}).get("content", [])
            if not isinstance(content, list):
                continue
            for item in content:
                if not isinstance(item, dict) or item.get("type") != "tool_use":
                    continue
                name = item.get("name", "")
                inp = item.get("input", {})
                if name == "Edit" and inp.get("file_path"):
                    current_turn["files_edited"].append(inp["file_path"])
                elif name == "Write" and inp.get("file_path"):
                    current_turn["files_written"].append(inp["file_path"])
                elif name == "Bash":
                    desc = inp.get("description", "") or inp.get("command", "")[:80]
                    if desc:
                        current_turn["actions"].append(desc[:120])

    return turns


# ── Cursor sessions ───────────────────────────────────────────────────────────

def load_cursor_sessions(cwd: str, since: datetime, until: datetime):
    """
    Read Cursor composer headers from globalStorage SQLite.
    Falls back to ai-tracking DB if available.
    """
    results = []

    # Primary: globalStorage composer headers
    global_db = Path.home() / "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
    if global_db.exists():
        results.extend(_cursor_from_global_db(global_db, cwd, since, until))

    # Fallback: ai-tracking.db (code hash level)
    tracking_db = Path.home() / ".cursor/ai-tracking/ai-code-tracking.db"
    if tracking_db.exists() and not results:
        results.extend(_cursor_from_tracking_db(tracking_db, cwd, since, until))

    return results


def _cursor_from_global_db(db: Path, cwd: str, since: datetime, until: datetime):
    try:
        import sqlite3
        conn = sqlite3.connect(str(db))
        row = conn.execute(
            "SELECT value FROM ItemTable WHERE key='composer.composerHeaders'"
        ).fetchone()
        conn.close()
        if not row:
            return []
        data = json.loads(row[0])
        composers = data.get("allComposers", [])
    except Exception:
        return []

    # Find workspace ID for this project
    ws_db_path = _find_cursor_workspace_db(cwd)
    ws_id = ws_db_path.parent.name if ws_db_path else None

    sessions = []
    for c in composers:
        updated_ms = c.get("lastUpdatedAt", 0)
        created_ms = c.get("createdAt", 0)
        if not updated_ms and not created_ms:
            continue

        ts_ms = updated_ms or created_ms
        ts = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        if not (since <= ts <= until):
            continue

        # Filter to this workspace
        wi = c.get("workspaceIdentifier", {})
        if isinstance(wi, dict):
            c_ws_id = wi.get("id", "")
        else:
            c_ws_id = ""

        repos = c.get("trackedGitRepos", [])
        repo_paths = [r.get("repoPath", "") for r in repos if isinstance(r, dict)]

        if ws_id and c_ws_id != ws_id:
            # Only include if repo path matches
            if not any(cwd in rp or rp in cwd for rp in repo_paths):
                continue

        name = c.get("name") or c.get("subtitle", "?")
        subtitle = c.get("subtitle", "")
        lines_added = c.get("totalLinesAdded", 0)
        lines_removed = c.get("totalLinesRemoved", 0)
        files_count = c.get("filesChangedCount", 0)

        sessions.append({
            "source": "cursor",
            "ts": ts,
            "name": name[:80],
            "subtitle": subtitle[:200],
            "lines_added": lines_added,
            "lines_removed": lines_removed,
            "files_count": files_count,
            "composer_id": c.get("composerId", ""),
        })

    return sorted(sessions, key=lambda s: s["ts"])


def _find_cursor_workspace_db(cwd: str) -> Optional[Path]:
    ws_storage = Path.home() / "Library/Application Support/Cursor/User/workspaceStorage"
    if not ws_storage.exists():
        return None
    for ws_json in ws_storage.glob("*/workspace.json"):
        try:
            data = json.loads(ws_json.read_text())
            folder = data.get("folder", "")
            if cwd in folder or folder.endswith(cwd.split("/")[-1]):
                return ws_json.parent / "state.vscdb"
        except Exception:
            pass
    return None


def _cursor_from_tracking_db(db: Path, cwd: str, since: datetime, until: datetime):
    try:
        import sqlite3
        conn = sqlite3.connect(str(db))
        since_ms = int(since.timestamp() * 1000)
        until_ms = int(until.timestamp() * 1000)
        rows = conn.execute("""
            SELECT conversationId,
                   count(DISTINCT fileName) as files,
                   min(createdAt) as start_ms,
                   max(createdAt) as end_ms
            FROM ai_code_hashes
            WHERE fileName LIKE ?
            AND createdAt >= ? AND createdAt <= ?
            GROUP BY conversationId
            ORDER BY min(createdAt) ASC
        """, (f"%{os.path.basename(cwd)}%", since_ms, until_ms)).fetchall()
        conn.close()
    except Exception:
        return []

    sessions = []
    for conv_id, files, start_ms, end_ms in rows:
        ts = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc)
        sessions.append({
            "source": "cursor",
            "ts": ts,
            "name": f"Cursor session {conv_id[:8]}",
            "subtitle": "",
            "lines_added": 0,
            "lines_removed": 0,
            "files_count": files,
            "composer_id": conv_id,
        })
    return sessions


# ── git log ───────────────────────────────────────────────────────────────────

def load_git_commits(cwd: str, since: datetime, until: datetime):
    since_str = since.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    until_str = until.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    try:
        out = subprocess.check_output(
            ["git", "log",
             f"--since={since_str}", f"--until={until_str}",
             "--pretty=format:%H|%ai|%s|%an",
             "--no-merges"],
            cwd=cwd, stderr=subprocess.DEVNULL, text=True
        )
    except subprocess.CalledProcessError:
        return []

    commits = []
    for line in out.strip().splitlines():
        parts = line.split("|", 3)
        if len(parts) < 4:
            continue
        sha, ts_str, subject, author = parts
        try:
            ts = datetime.fromisoformat(ts_str).astimezone(timezone.utc)
        except ValueError:
            continue
        commits.append({"sha": sha[:8], "ts": ts, "subject": subject, "author": author})
    return commits


# ── report builder ────────────────────────────────────────────────────────────

def build_report(claude_sessions, cursor_sessions, git_commits,
                 since: datetime, until: datetime, cwd: str) -> str:
    # Collect all touched files from Claude
    claude_files = set()
    for s in claude_sessions:
        for t in s["turns"]:
            claude_files.update(t["files_edited"] + t["files_written"])

    cursor_total_files = sum(s.get("files_count", 0) for s in cursor_sessions)
    cursor_lines_added = sum(s.get("lines_added", 0) for s in cursor_sessions)
    cursor_lines_removed = sum(s.get("lines_removed", 0) for s in cursor_sessions)

    lines = []
    lines.append("# Agent Changes Report")
    lines.append("")
    lines.append(f"**Time Range**: {since.astimezone().strftime('%Y-%m-%d %H:%M')} → {until.astimezone().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"**Project**: `{cwd}`")
    lines.append("")
    lines.append("| Source | Sessions | Files Touched | Lines +/- |")
    lines.append("|---|---|---|---|")
    claude_turns = sum(len(s["turns"]) for s in claude_sessions)
    lines.append(f"| Claude Code | {len(claude_sessions)} sessions / {claude_turns} turns | {len(claude_files)} | — |")
    lines.append(f"| Cursor | {len(cursor_sessions)} sessions | ~{cursor_total_files} | +{cursor_lines_added} / -{cursor_lines_removed} |")
    lines.append(f"| Git Commits | — | — | {len(git_commits)} commits |")
    lines.append("")
    lines.append("---")

    # ── Claude section ──
    if claude_sessions:
        lines.append("")
        lines.append("## Claude Code Sessions")
        lines.append("")
        for idx, sess in enumerate(claude_sessions, 1):
            if not sess["turns"]:
                continue
            first_ts = sess["turns"][0]["ts"]
            ts_str = first_ts.astimezone().strftime("%Y-%m-%d %H:%M") if first_ts else "unknown"
            lines.append(f"### Session {idx} — {ts_str}")
            lines.append("")

            sess_files = defaultdict(int)
            sess_written = set()
            for turn in sess["turns"]:
                for fp in turn["files_edited"]:
                    sess_files[fp] += 1
                sess_written.update(turn["files_written"])

            for t_idx, turn in enumerate(sess["turns"], 1):
                ts = turn["ts"].astimezone().strftime("%H:%M") if turn["ts"] else "??"
                prompt = turn["prompt"].replace("\n", " ")
                lines.append(f"{t_idx}. `{ts}` {prompt}")
            lines.append("")

            if sess_files or sess_written:
                lines.append("**Files:**")
                for fp, cnt in sorted(sess_files.items()):
                    short = shorten_path(fp, cwd)
                    suffix = f" ×{cnt}" if cnt > 1 else ""
                    lines.append(f"- `{short}`{suffix}")
                for fp in sorted(sess_written):
                    if fp not in sess_files:
                        lines.append(f"- `{shorten_path(fp, cwd)}` (new)")
                lines.append("")

    # ── Cursor section ──
    if cursor_sessions:
        lines.append("## Cursor Sessions")
        lines.append("")
        for idx, sess in enumerate(cursor_sessions, 1):
            ts_str = sess["ts"].astimezone().strftime("%Y-%m-%d %H:%M")
            name = sess["name"]
            subtitle = sess["subtitle"]
            la = sess.get("lines_added", 0)
            lr = sess.get("lines_removed", 0)
            fc = sess.get("files_count", 0)
            lines.append(f"### {idx}. {name} — {ts_str}")
            if subtitle and subtitle != name:
                lines.append(f"> {subtitle}")
            lines.append("")
            lines.append(f"Files: {fc} | Lines: +{la} / -{lr}")
            lines.append("")

    # ── Git commits section ──
    if git_commits:
        lines.append("## Git Commits")
        lines.append("")
        for c in git_commits:
            ts_str = c["ts"].astimezone().strftime("%m-%d %H:%M")
            lines.append(f"- `{c['sha']}` `{ts_str}` {c['subject']} — *{c['author']}*")
        lines.append("")

    # ── All Claude files ──
    if claude_files:
        lines.append("## All Files Touched (Claude)")
        lines.append("")
        for fp in sorted(claude_files):
            lines.append(f"- `{shorten_path(fp, cwd)}`")
        lines.append("")

    lines.append(f"*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*")
    return "\n".join(lines)


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()
    now = datetime.now(timezone.utc)
    cwd = os.path.abspath(args.project or os.getcwd())

    if args.since:
        s = args.since + ("T00:00:00" if "T" not in args.since else "")
        since = datetime.fromisoformat(s).astimezone(timezone.utc)
    elif args.hours:
        since = now - timedelta(hours=args.hours)
    elif args.days:
        since = now - timedelta(days=args.days)
    else:
        today = now.astimezone()
        since = today.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)

    if args.until:
        u = args.until + ("T23:59:59" if "T" not in args.until else "")
        until = datetime.fromisoformat(u).astimezone(timezone.utc)
    else:
        until = now

    print(f"Loading sessions {since.astimezone().strftime('%Y-%m-%d %H:%M')} → {until.astimezone().strftime('%Y-%m-%d %H:%M')} ...", file=sys.stderr)

    claude_sessions = load_claude_sessions(cwd, since, until)
    cursor_sessions = load_cursor_sessions(cwd, since, until)
    git_commits = load_git_commits(cwd, since, until)

    print(f"  Claude: {len(claude_sessions)} sessions", file=sys.stderr)
    print(f"  Cursor: {len(cursor_sessions)} sessions", file=sys.stderr)
    print(f"  Git:    {len(git_commits)} commits", file=sys.stderr)

    report = build_report(claude_sessions, cursor_sessions, git_commits, since, until, cwd)

    if args.print:
        print(report)
        return

    if args.output:
        out_path = Path(args.output)
    else:
        date_str = now.astimezone().strftime("%Y-%m-%d")
        out_dir = Path(cwd) / "docs" / "agent-changes"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"report-{date_str}.md"

    out_path.write_text(report, encoding="utf-8")
    print(f"Report written to: {out_path}")


if __name__ == "__main__":
    main()
