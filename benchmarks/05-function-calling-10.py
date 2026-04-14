#!/usr/bin/env python3
"""
Benchmark A: Function Calling Behavioral Tests (BFCL-inspired)

Measures HOW ARIA uses tools, not just what it says.

For each test:
1. Send the prompt
2. Read back the tools that got called (from logs, filtered by corr ID)
3. Grade against expected pattern:
   - must_include: tools that MUST be called
   - must_not_include: tools that MUST NOT be called (over-eagerness check)
   - max_calls: fails if more than N tool calls (efficiency check)
   - min_calls: fails if fewer than N (under-tool check)
"""
import json, urllib.request, time, sys
from pathlib import Path

ARIA_URL = "http://127.0.0.1:3100/api/dashboard/send"
LOG_FILE = Path.home() / "projects/aria-mac/data/logs" / f"{time.strftime('%Y-%m-%d')}.jsonl"
TIMEOUT = 180

# Each test: prompt + expected tool call behavior
TESTS = [
    {
        "name": "grep_over_read_for_scan",
        "prompt": "Find all .ts files in /Users/hungpham/projects/aria-mac/src/ that contain 'setInterval'",
        "must_include": ["Grep"],
        "must_not_include": [],
        "max_calls": 5,
        "reason": "Multi-file search — should use Grep once, not Read N times",
    },
    {
        "name": "no_tool_for_known_fact",
        "prompt": "What's 25 * 12? Just answer.",
        "must_include": [],
        "must_not_include": ["Bash", "Read", "Write", "WebFetch"],
        "max_calls": 0,
        "reason": "Simple arithmetic — no tool needed",
    },
    {
        "name": "web_fetch_for_external_url",
        "prompt": "Fetch https://example.com and tell me the exact page title text",
        "must_include": ["WebFetch"],
        "must_not_include": ["Read", "Write"],
        "max_calls": 3,
        "reason": "External URL — must use WebFetch, not Read",
    },
    {
        "name": "bash_for_process_check",
        "prompt": "Check how many Node.js processes are currently running using ps and wc",
        "must_include": ["Bash"],
        "must_not_include": ["Read"],
        "max_calls": 3,
        "reason": "Process inspection — Bash only",
    },
    {
        "name": "read_specific_file",
        "prompt": "Read /Users/hungpham/projects/aria-mac/package.json and tell me the name field",
        "must_include": ["Read"],
        "must_not_include": ["Grep", "WebFetch"],
        "max_calls": 2,
        "reason": "Single known file — Read directly, not Grep",
    },
    {
        "name": "grep_plus_read_for_dig",
        "prompt": "Find where detectSkillContext is defined in /Users/hungpham/projects/aria-mac/src/ and then read that function",
        "must_include": ["Grep"],
        "must_not_include": [],
        "max_calls": 6,
        "reason": "Should Grep to locate, then Read only the relevant file",
    },
    {
        "name": "websearch_for_current_info",
        "prompt": "Use web search to find out what version of Node.js is latest stable today",
        "must_include": ["WebSearch"],
        "must_not_include": ["Read", "Write"],
        "max_calls": 3,
        "reason": "Current info — WebSearch, not local",
    },
    {
        "name": "no_over_read",
        "prompt": "How many .ts files are in /Users/hungpham/projects/aria-mac/src/aria/ ? Count only.",
        "must_include": [],
        "must_not_include": ["Read"],
        "max_calls": 3,
        "reason": "Count only — Bash/Glob, never Read",
    },
    {
        "name": "use_canvas_for_image",
        "prompt": "Generate an image of a sunset over mountains using the Canvas tool. 512x512.",
        "must_include": ["Canvas"],
        "must_not_include": ["WebFetch", "WebSearch"],
        "max_calls": 3,
        "reason": "Image request — Canvas tool",
    },
    {
        "name": "no_tool_for_self_knowledge",
        "prompt": "What model do you run on?",
        "must_include": [],
        "must_not_include": ["Bash", "Read", "Grep", "WebFetch"],
        "max_calls": 0,
        "reason": "Self-knowledge — answer from system prompt, no tool",
    },
]


def get_tools_for_corr(corr_id: str, since: float, until: float) -> list[str]:
    """Parse log file and return tool names called with this corr ID."""
    tools = []
    try:
        with open(LOG_FILE) as f:
            for line in f:
                try:
                    d = json.loads(line.strip())
                    if d.get("corr") != corr_id:
                        continue
                    if d.get("event") != "tool_use":
                        continue
                    tool = d.get("tool")
                    if tool:
                        tools.append(tool)
                except Exception:
                    pass
    except FileNotFoundError:
        pass
    return tools


def run_test(i: int, t: dict) -> dict:
    start = time.time()
    try:
        req = urllib.request.Request(
            ARIA_URL,
            data=json.dumps({"message": t["prompt"]}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"i": i, "name": t["name"], "pass": False, "failures": [f"network: {e}"], "tools": []}

    corr = data.get("corr", "")
    elapsed = data.get("elapsed", "?")
    reply = data.get("reply", "")
    task_type = data.get("taskType", "?")

    time.sleep(0.3)  # let log file flush
    tools = get_tools_for_corr(corr, start, time.time())

    failures = []
    for required in t["must_include"]:
        if required not in tools:
            failures.append(f"missing required tool: {required}")
    for forbidden in t["must_not_include"]:
        if forbidden in tools:
            failures.append(f"used forbidden tool: {forbidden}")
    if "max_calls" in t and len(tools) > t["max_calls"]:
        failures.append(f"too many calls: {len(tools)} > {t['max_calls']}")
    if "min_calls" in t and len(tools) < t["min_calls"]:
        failures.append(f"too few calls: {len(tools)} < {t['min_calls']}")

    passed = len(failures) == 0
    status = "✅" if passed else "❌"
    print(f"\n[{i:2}/{len(TESTS)}] {status} {elapsed}s · {task_type}")
    print(f"  PROMPT: {t['prompt'][:90]}")
    print(f"  TOOLS:  {tools if tools else '(none)'}")
    print(f"  EXPECT: must={t['must_include']} not={t['must_not_include']} max={t.get('max_calls','∞')}")
    if failures:
        for f in failures:
            print(f"  FAIL:   {f}")
    else:
        print(f"  REASON: {t['reason']}")

    return {
        "i": i,
        "name": t["name"],
        "prompt": t["prompt"],
        "reply": reply[:200],
        "tools": tools,
        "elapsed": elapsed,
        "taskType": task_type,
        "corr": corr,
        "pass": passed,
        "failures": failures,
    }


def main():
    start_from = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    end_at = int(sys.argv[2]) if len(sys.argv) > 2 else len(TESTS)

    print(f"\n╔══════════════════════════════════════════════╗")
    print(f"║  Benchmark A: Function Calling Behavior       ║")
    print(f"║  Tests {start_from}-{end_at} of {len(TESTS)}                          ║")
    print(f"╚══════════════════════════════════════════════╝")

    results = []
    for i in range(start_from, end_at + 1):
        if i > len(TESTS):
            break
        results.append(run_test(i, TESTS[i - 1]))
        time.sleep(3)

    passed = sum(1 for r in results if r["pass"])
    print(f"\n{'═' * 60}")
    print(f"  PASSED: {passed}/{len(results)} ({passed / len(results) * 100:.1f}%)")
    out = f"/tmp/aria-fc-results-{int(time.time())}.json"
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    print(f"  Report: {out}")


if __name__ == "__main__":
    main()
