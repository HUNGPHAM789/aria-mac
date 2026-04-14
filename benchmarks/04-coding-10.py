#!/usr/bin/env python3
"""10 advanced coding tests — target 100% pass."""
import json, urllib.request, urllib.error, time, sys

ARIA_URL = "http://127.0.0.1:3100/api/dashboard/send"
TIMEOUT = 300

TESTS = [
    # ─── Architecture analysis ───
    ("Analyze the architecture of /Users/hungpham/projects/aria-mac/src/aria/task-runner.ts — what design pattern does it use and why",
     "architecture"),
    ("Investigate how /Users/hungpham/projects/aria-mac/src/aria/core.ts handles the 3 safety nets (continuation, silent-exit, promise detector) — describe each briefly",
     "architecture"),

    # ─── Refactor proposals (read-only, no edits) ───
    ("Review /Users/hungpham/projects/aria-mac/src/aria/memory.ts and propose 2 refactoring improvements — don't edit, just describe",
     "refactor"),
    ("Analyze the classifyTask function in /Users/hungpham/projects/aria-mac/src/aria/task-runner.ts — suggest how to make the regex patterns more maintainable (do not edit)",
     "refactor"),

    # ─── Bug hunting ───
    ("Check /Users/hungpham/projects/aria-mac/src/aria/tools-executor.ts for race conditions — specifically look at _browser singleton and concurrent page.close usage",
     "bug-hunt"),
    ("Investigate /Users/hungpham/projects/aria-mac/src/aria/quality-judge.ts for potential infinite loops or unhandled edge cases",
     "bug-hunt"),

    # ─── Dependency / API analysis ───
    ("Grep for 'export function' across /Users/hungpham/projects/aria-mac/src/ and count public functions per file. Use grep -c approach via Bash.",
     "api-analysis"),
    ("Analyze the imports in /Users/hungpham/projects/aria-mac/src/aria/handlers.ts — wait check, does that file exist? If not, list files in /Users/hungpham/projects/aria-mac/src/telegram/",
     "dependency"),

    # ─── Code quality metrics ───
    ("Check which .ts files in /Users/hungpham/projects/aria-mac/src/ are longest (line counts) — use wc -l on all ts files",
     "metrics"),
    ("Analyze /Users/hungpham/projects/aria-mac/package.json — what's the full dependency graph (direct deps only), and are there any security concerns for the listed versions?",
     "metrics"),
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
            has_response = bool(reply and len(reply.strip()) > 50)
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
    print(f"║  ARIA Advanced Coding Battle              ║")
    print(f"║  Tests {start_from}-{end_at}                              ║")
    print(f"╚══════════════════════════════════════════╝")
    results = []
    for i in range(start_from, end_at + 1):
        if i > len(TESTS): break
        prompt, category = TESTS[i - 1]
        result = run_test(i, prompt, category)
        results.append(result)
        time.sleep(3)
    passed = sum(1 for r in results if r.get('pass'))
    print(f"\n{'═'*60}")
    print(f"  PASSED: {passed}/{len(results)} ({passed/len(results)*100:.1f}%)")
    out = f"/tmp/aria-coding-results-{int(time.time())}.json"
    with open(out, 'w') as f: json.dump(results, f, indent=2)
    print(f"  Report: {out}")

if __name__ == '__main__':
    main()
