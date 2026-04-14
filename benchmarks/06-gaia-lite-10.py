#!/usr/bin/env python3
"""
Benchmark B: GAIA-lite — verifiable single-answer questions.

Each test has a verifiable expected answer. ARIA must:
1. Use the right tool(s) to fetch/compute the answer
2. Include the expected token (number, string, regex match) in its reply

Grading is substring/regex match on the reply text — not exact equality —
to allow for natural-language framing around the answer.
"""
import json, os, sys, time, re
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from backends import get_backend

BACKEND_NAME = os.environ.get("BACKEND", "aria")
TIMEOUT = 300

# Each test: prompt + answer expectation
# expect_regex: regex pattern that must match somewhere in reply (case-insensitive)
# expect_any:   list of strings — at least one must appear in reply
# expect_all:   list of strings — all must appear in reply
TESTS = [
    {
        "name": "package_json_name",
        "prompt": "Read /Users/hungpham/projects/aria-mac/package.json and tell me the exact value of the 'name' field.",
        "expect_any": ["aria-mac", "\"aria-mac\""],
        "reason": "Single fact extraction from a known file.",
    },
    {
        "name": "count_ts_files",
        "prompt": "How many .ts files are directly in /Users/hungpham/projects/aria-mac/src/aria/ (not subdirs)? Give just the number.",
        "expect_regex": r"\b(1[0-9]|[2-9][0-9])\b",  # expect 10-99
        "reason": "File count via Bash/Glob — must be a 2-digit number.",
    },
    {
        "name": "longest_ts_file",
        "prompt": "Which .ts file in /Users/hungpham/projects/aria-mac/src/aria/ has the most lines? Give me the filename only.",
        "expect_any": ["core.ts", "tools-executor.ts", "task-runner.ts", "memory.ts"],
        "reason": "Need to wc -l and pick the max — verifiable.",
    },
    {
        "name": "node_processes",
        "prompt": "How many node processes are currently running on this Mac? Use ps. Give just the integer.",
        "expect_regex": r"\b\d+\b",
        "reason": "Process count via Bash — any integer is acceptable.",
    },
    {
        "name": "arithmetic_mental",
        "prompt": "What is 137 * 89? Just the number.",
        "expect_any": ["12193"],
        "reason": "Mental math — no tool, exact answer.",
    },
    {
        "name": "current_year",
        "prompt": "What year is it right now? Just the year.",
        "expect_any": ["2026"],
        "reason": "Self-knowledge / system date — no external lookup needed.",
    },
    {
        "name": "git_branch",
        "prompt": "What git branch is /Users/hungpham/projects/aria-mac on right now? Give the branch name only.",
        "expect_any": ["main", "master"],
        "reason": "Bash git command — verifiable.",
    },
    {
        "name": "example_com_title",
        "prompt": "Fetch https://example.com and tell me the exact text inside the <title> tag.",
        "expect_any": ["Example Domain"],
        "reason": "WebFetch — known stable URL, deterministic answer.",
    },
    {
        "name": "find_function_definition",
        "prompt": "In /Users/hungpham/projects/aria-mac/src/aria/, which file defines the function 'classifyTask'? Filename only.",
        "expect_any": ["task-runner.ts"],
        "reason": "Grep to locate definition — verifiable single answer.",
    },
    {
        "name": "package_json_dep_count",
        "prompt": "How many entries are in the 'dependencies' object of /Users/hungpham/projects/aria-mac/package.json? Just the number.",
        "expect_regex": r"\b([5-9]|[1-3]\d)\b",  # expect roughly 5-39 deps
        "reason": "Read + count — verifiable integer.",
    },
]


def grade(reply: str, t: dict) -> tuple[bool, str]:
    if not reply or not reply.strip():
        return False, "empty reply"
    r = reply.lower()
    if "expect_any" in t:
        for s in t["expect_any"]:
            if s.lower() in r:
                return True, f"matched '{s}'"
        return False, f"none of {t['expect_any']} found"
    if "expect_all" in t:
        missing = [s for s in t["expect_all"] if s.lower() not in r]
        if missing:
            return False, f"missing {missing}"
        return True, "all matched"
    if "expect_regex" in t:
        m = re.search(t["expect_regex"], reply, re.IGNORECASE)
        if m:
            return True, f"regex matched '{m.group(0)}'"
        return False, f"regex {t['expect_regex']} no match"
    return False, "no expectation defined"


def run_test(i: int, t: dict) -> dict:
    call = get_backend(BACKEND_NAME)
    data = call(t["prompt"], timeout=TIMEOUT)
    if data.get("error"):
        return {"i": i, "name": t["name"], "pass": False, "error": data["error"]}

    reply = data.get("reply", "")
    elapsed = data.get("elapsed", "?")
    task_type = data.get("taskType", "?")

    passed, why = grade(reply, t)
    status = "✅" if passed else "❌"
    print(f"\n[{i:2}/{len(TESTS)}] {status} {elapsed}s · {task_type}")
    print(f"  PROMPT: {t['prompt'][:90]}")
    print(f"  REPLY:  {reply[:200]}")
    print(f"  GRADE:  {why}")
    if not passed:
        print(f"  REASON: {t['reason']}")

    return {
        "i": i,
        "name": t["name"],
        "prompt": t["prompt"],
        "reply": reply[:500],
        "elapsed": elapsed,
        "taskType": task_type,
        "pass": passed,
        "grade": why,
    }


def main():
    start_from = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    end_at = int(sys.argv[2]) if len(sys.argv) > 2 else len(TESTS)

    print(f"\n╔══════════════════════════════════════════════╗")
    print(f"║  Benchmark B: GAIA-lite (verifiable answers)  ║")
    print(f"║  Tests {start_from}-{end_at} of {len(TESTS)}  · backend={BACKEND_NAME}                ║")
    print(f"╚══════════════════════════════════════════════╝")

    results = []
    for i in range(start_from, end_at + 1):
        if i > len(TESTS):
            break
        results.append(run_test(i, TESTS[i - 1]))
        time.sleep(3)

    passed = sum(1 for r in results if r.get("pass"))
    print(f"\n{'═' * 60}")
    print(f"  PASSED: {passed}/{len(results)} ({passed / len(results) * 100:.1f}%)")
    out = f"/tmp/aria-gaia-results-{BACKEND_NAME}-{int(time.time())}.json"
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    print(f"  Report: {out}")


if __name__ == "__main__":
    main()
