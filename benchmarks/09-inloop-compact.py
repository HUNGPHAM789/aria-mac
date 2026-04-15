#!/usr/bin/env python3
"""
Benchmark 09: In-loop compaction validation (Track C end-to-end).

Unlike bench 08 (which issued 40 separate POSTs and never grew a single
runClaude's messages[] past the threshold), this bench fires ONE POST
whose task induces 20+ tool calls inside a single runClaude invocation.
That way `messages[]` grows past ARIA_COMPRESS_THRESHOLD mid-run and the
in-loop compactor actually fires.

Methodology:
  1. Plant a MAGIC_WORD in a marker file at a known tmp path.
  2. Force Ollama path (gemma) — Claude SDK backend has its own context
     manager and doesn't use Track C.
  3. Single prompt: read marker, glob src/aria/*.ts, Read+summarize each,
     then recall the MAGIC_WORD.
  4. After the reply comes back, scan today's JSONL log for
     `context_compacted` events matching our corr. If none fired → the
     test is INVALID (raise threshold or grow workload).
  5. Verdict:
       PASS    = compaction fired AND reply contains MAGIC_WORD
       FAIL    = compaction fired BUT MAGIC_WORD missing (Track C lost it)
       INVALID = compaction didn't fire (workload too small for threshold)
       ERROR   = HTTP/daemon error

Requirements:
  - Daemon running at :3100
  - Ollama model configured (`aria_model` pref set to gemma or gpt-oss)
  - Recommended: restart daemon with ARIA_COMPRESS_THRESHOLD=8000 so the
    bench triggers compaction in a reasonable number of file reads
    (~15-20 reads × ~500 tokens/result crosses 8K well before the loop
    ends). At the default 60K the workload would need ~100 reads which
    exceeds runClaude's maxTurns=40 cap.
"""
import json, os, random, sqlite3, string, sys, time, urllib.request
from pathlib import Path

ARIA_DB = Path.home() / "projects" / "aria-mac" / "data" / "aria.db"
ARIA_URL = "http://127.0.0.1:3100/api/dashboard/send"
LOG_DIR = Path.home() / "projects" / "aria-mac" / "data" / "logs"
TIMEOUT = int(os.environ.get("TIMEOUT", "600"))  # 10 min — 25 reads × 10s each


def check_model() -> str | None:
    """Return current aria_model pref. None if DB missing."""
    if not ARIA_DB.exists():
        return None
    con = sqlite3.connect(str(ARIA_DB))
    try:
        row = con.execute(
            "SELECT pref_value FROM preferences WHERE pref_key='aria_model'"
        ).fetchone()
        return row[0] if row else None
    finally:
        con.close()


def set_model(alias: str) -> None:
    con = sqlite3.connect(str(ARIA_DB))
    try:
        con.execute(
            "INSERT INTO preferences(pref_key,pref_value) VALUES('aria_model',?) "
            "ON CONFLICT(pref_key) DO UPDATE SET pref_value=excluded.pref_value",
            (alias,),
        )
        con.commit()
    finally:
        con.close()


def post(message: str, timeout: int) -> dict:
    req = urllib.request.Request(
        ARIA_URL,
        data=json.dumps({"message": message}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
        data["elapsed_real"] = time.time() - t0
        return data
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}", "elapsed_real": time.time() - t0}


def scan_log_for_corr(corr: str) -> list[dict]:
    """Return all events matching the given corr across the last 2 daily logs."""
    events: list[dict] = []
    today = time.strftime("%Y-%m-%d")
    for day_offset in (0, -1):
        date = time.strftime("%Y-%m-%d", time.localtime(time.time() + day_offset * 86400))
        path = LOG_DIR / f"{date}.jsonl"
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get("corr") == corr:
                events.append(ev)
    return events


def main() -> int:
    # 1) Pre-flight: model must route through Ollama path.
    current = check_model()
    print(f"  aria_model (before): {current!r}")
    original_model = current
    ollama_aliases = {"gemma", "gpt-oss"}
    if current not in ollama_aliases:
        target = os.environ.get("BENCH_MODEL", "gemma")
        print(f"  → forcing aria_model={target} for this bench (will restore after)")
        set_model(target)

    # 2) Plant marker.
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    magic_word = f"fergus-quartz-{rand}"
    marker_path = Path(f"/tmp/aria-bench-09-marker-{rand}.txt")
    marker_path.write_text(
        f"MAGIC_WORD={magic_word}\n"
        f"This is a marker file for ARIA compaction bench 09.\n"
        f"The word above must be remembered through context compaction.\n"
    )
    print(f"  marker: {marker_path}")
    print(f"  MAGIC_WORD={magic_word}")

    # 3) Build the task. Enough tool calls to grow messages[] past threshold.
    prompt = f"""Please complete these steps IN ORDER. Do not skip any.

STEP 1: Use the Read tool to read {marker_path}. Note the MAGIC_WORD value silently — you will need it at the end.

STEP 2: Use Glob with pattern "src/aria/*.ts" to list all TypeScript files in the aria directory.

STEP 3: For EACH file returned by glob, use Read to read it, then write ONE sentence describing its purpose. Do this for ALL files — do not stop early. Format each as:
  - <filename>: <one-sentence purpose>

STEP 4: After you have summarized every file from step 2, write exactly this line on its own:
  FINAL_ANSWER_MAGIC_WORD=<the word you saw in step 1>

Be thorough. The goal is to exercise your tool-use across many files in one session."""

    # 4) Fire.
    t0 = time.time()
    print(f"  POSTing task (timeout={TIMEOUT}s)…")
    resp = post(prompt, TIMEOUT)
    elapsed = time.time() - t0

    # 5) Restore model.
    if original_model and original_model != check_model():
        print(f"  restoring aria_model → {original_model!r}")
        set_model(original_model)

    if resp.get("error"):
        print(f"  ERROR: {resp['error']}  ({elapsed:.1f}s)")
        marker_path.unlink(missing_ok=True)
        return _report("error", False, False, magic_word, resp, [], elapsed)

    reply = resp.get("reply", "")
    corr = resp.get("corr", "")
    print(f"  reply received in {elapsed:.1f}s ({len(reply)} chars), corr={corr}")
    print(f"  --- reply tail ---\n{reply[-1200:]}\n  ---")

    # 6) Scan log for compaction event under this corr.
    events = scan_log_for_corr(corr)
    compact_events = [e for e in events if e.get("event") == "context_compacted"]
    tool_events = [e for e in events if e.get("event") == "tool_use"]
    req_events = [e for e in events if e.get("event") == "request_out"]
    peak_input = max((e.get("input_tokens", 0) for e in req_events), default=0)
    print(f"  tool_use events: {len(tool_events)}   context_compacted events: {len(compact_events)}   peak input_tokens: {peak_input}")
    for ce in compact_events:
        print(f"    → compact: {ce.get('beforeTokens')}→{ce.get('afterTokens')} toks "
              f"| {ce.get('beforeCount')}→{ce.get('afterCount')} msgs | llm={ce.get('llm')}")

    has_marker = magic_word in reply
    compacted = len(compact_events) > 0

    if not compacted:
        verdict = "invalid"
        passed = False
        print("  VERDICT: INVALID — compaction never fired. Lower ARIA_COMPRESS_THRESHOLD or grow workload.")
    elif has_marker:
        verdict = "pass"
        passed = True
        print("  VERDICT: ✅ PASS — compaction fired AND MAGIC_WORD preserved.")
    else:
        verdict = "fail_lost_marker"
        passed = False
        print("  VERDICT: ❌ FAIL — compaction fired but MAGIC_WORD was lost.")

    marker_path.unlink(missing_ok=True)
    return _report(verdict, passed, has_marker, magic_word, resp, compact_events, elapsed,
                   tool_calls=len(tool_events), corr=corr)


def _report(verdict: str, passed: bool, has_marker: bool, magic: str,
            resp: dict, compact_events: list[dict], elapsed: float,
            tool_calls: int = 0, corr: str = "") -> int:
    out = {
        "bench": "09-inloop-compact",
        "verdict": verdict,
        "passed": passed,
        "has_marker": has_marker,
        "magic_word": magic,
        "corr": corr,
        "elapsed_s": round(elapsed, 1),
        "tool_calls": tool_calls,
        "compaction_events": len(compact_events),
        "compactions": [
            {k: e.get(k) for k in ("beforeTokens", "afterTokens", "beforeCount", "afterCount", "llm", "thread")}
            for e in compact_events
        ],
        "reply_len": len(resp.get("reply", "")),
        "reply": resp.get("reply", ""),
        "error": resp.get("error", ""),
        "timestamp": int(time.time()),
    }
    path = Path("/tmp") / f"aria-bench-09-{int(time.time())}.json"
    path.write_text(json.dumps(out, indent=2))
    print(f"  Report: {path}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
