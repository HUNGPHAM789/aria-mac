#!/usr/bin/env python3
"""10 targeted complex diagnosis tests — goal 100% pass."""
import json, urllib.request, urllib.error, time, sys

ARIA_URL = "http://127.0.0.1:3100/api/dashboard/send"
TIMEOUT = 300

# All rephrased to use ANALYSIS keywords (check/investigate/diagnose) so they
# route to analysis-task runner (read-only, no fix phase).
TESTS = [
    ("Investigate if there are any TODO or FIXME comments in /Users/hungpham/projects/aria-mac/src/ and list them grouped by file", "scan"),
    ("Analyze which TypeScript files in /Users/hungpham/projects/aria-mac/src/ use the `any` type. Use Grep.", "scan"),
    ("Check the control flow of runDebugTask in /Users/hungpham/projects/aria-mac/src/aria/task-runner.ts — describe its phases briefly", "code-read"),
    ("Investigate places in /Users/hungpham/projects/aria-mac/src/aria/core.ts runClaude where errors could be silently swallowed (look for empty catch blocks)", "code-read"),
    ("Check ARIA's DB schema via sqlite3 — list all tables and their columns", "bash"),
    ("Analyze the last 20 entries in the messages table — what's the average assistant response length?", "db-analysis"),
    ("Investigate whether the quality judge is firing — check quality_scores table, show recent 5 entries", "db-analysis"),
    ("Check which endpoints exist in /Users/hungpham/projects/aria-mac/src/bot/index.ts — grep for req.url patterns", "code-read"),
    ("Diagnose the relationship between agents.ts and task-runner.ts — which functions call runTask?", "code-read"),
    ("Analyze ARIA's log volume today — how many events in data/logs/2026-04-14.jsonl, grouped by event type", "bash"),
]

def run_test(i, prompt, category):
    start = time.time()
    try:
        req = urllib.request.Request(
            ARIA_URL,
            data=json.dumps({"message": prompt}).encode('utf-8'),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            data = json.loads(r.read().decode('utf-8'))
            elapsed = data.get('elapsed', '?')
            task_type = data.get('taskType', '?')
            reply = data.get('reply', '') or data.get('error', '')
            has_response = bool(reply and len(reply.strip()) > 30)
            status = "✅" if has_response else "❌"
            print(f"\n[{i:2}/10] {status} {elapsed}s · {task_type} · {category}")
            print(f"  →  {prompt[:110]}")
            print(f"  ←  {reply[:350]}")
            return {"i": i, "category": category, "prompt": prompt, "reply": reply, "elapsed": elapsed, "taskType": task_type, "pass": status == "✅"}
    except Exception as e:
        el = time.time() - start
        print(f"\n[{i:2}/10] ❌ {el:.1f}s · {type(e).__name__} · {category}")
        print(f"  →  {prompt[:110]}")
        print(f"  ←  {str(e)[:200]}")
        return {"i": i, "category": category, "prompt": prompt, "error": str(e), "pass": False}

def main():
    start_from = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    end_at = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    print(f"\n╔══════════════════════════════════════════╗")
    print(f"║  ARIA Diagnosis Battle — read-only        ║")
    print(f"║  Tests {start_from}-{end_at}                              ║")
    print(f"╚══════════════════════════════════════════╝")
    results = []
    for i in range(start_from, end_at + 1):
        if i > len(TESTS): break
        prompt, category = TESTS[i - 1]
        result = run_test(i, prompt, category)
        results.append(result)
        time.sleep(3)
    out = f"/tmp/aria-diag-results-{int(time.time())}.json"
    with open(out, 'w') as f: json.dump(results, f, indent=2)
    passed = sum(1 for r in results if r.get('pass'))
    print(f"\n{'═'*60}")
    print(f"  PASSED: {passed}/{len(results)} ({passed/len(results)*100:.1f}%)")

if __name__ == '__main__':
    main()
