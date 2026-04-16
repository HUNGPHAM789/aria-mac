#!/usr/bin/env python3
"""
Benchmark 10: Long Tasks — 8 realistic multi-step tasks.

Each task requires ARIA to plan, execute multiple tool calls, handle
intermediate results, and produce a concrete deliverable that can be
machine-verified. These mirror real work Boss would ask ARIA to do.

Scoring: each task has validators that check for concrete artifacts
(files exist, content matches, data correct). No vibes.

Expected: 5-20 min per task, 10-40 tool calls each.
Total suite: ~60-120 min.
"""
import json, os, re, subprocess, sys, time, shutil
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from backends import get_backend

BACKEND = os.environ.get("BACKEND", "aria")
TIMEOUT = int(os.environ.get("TASK_TIMEOUT", "600"))  # 10 min per task
WORK_DIR = Path("/tmp/aria-bench-10")


def clean_workdir():
    if WORK_DIR.exists():
        shutil.rmtree(WORK_DIR)
    WORK_DIR.mkdir(parents=True)


def call(prompt: str) -> dict:
    backend = get_backend(BACKEND)
    return backend(prompt, timeout=TIMEOUT)


# ─── Task definitions ────────────────────────────────────────────────────────

def task_build_and_test_script():
    """Build a script from spec, run it, verify output."""
    name = "build_and_test"
    out_file = WORK_DIR / "fibonacci.ts"
    prompt = (
        f"Write a TypeScript file at {out_file} that exports a function "
        f"`fib(n: number): number` returning the nth Fibonacci number (0-indexed: fib(0)=0, fib(1)=1, fib(10)=55). "
        f"Also include a self-test block at the bottom that runs when executed directly: "
        f"it should test fib(0)=0, fib(1)=1, fib(5)=5, fib(10)=55, fib(20)=6765, "
        f"print PASS or FAIL for each, and exit with code 1 if any fail. "
        f"After writing the file, RUN it with `npx tsx {out_file}` and tell me if all tests pass."
    )
    r = call(prompt)
    if r.get("error"):
        return name, False, f"ERROR: {r['error']}", r

    # Validate: file exists + run it ourselves
    if not out_file.exists():
        return name, False, "file not created", r

    try:
        result = subprocess.run(
            ["npx", "--yes", "tsx", str(out_file)],
            capture_output=True, text=True, timeout=30,
            cwd=str(WORK_DIR),
        )
        output = result.stdout + result.stderr
        if result.returncode == 0 and "FAIL" not in output.upper():
            return name, True, f"all tests pass (exit 0)", r
        return name, False, f"exit={result.returncode}: {output[:200]}", r
    except Exception as e:
        return name, False, f"exec error: {e}", r


def task_codebase_analysis():
    """Read real ARIA source files and produce structured analysis."""
    name = "codebase_analysis"
    report_file = WORK_DIR / "analysis.json"
    prompt = (
        f"Analyze the ARIA codebase at ~/projects/aria-mac/src/aria/. "
        f"Read at least 8 .ts files. For each file, record: filename, line count, "
        f"a one-sentence purpose, and the names of all exported functions/classes. "
        f"Write the results as a JSON array to {report_file}. "
        f"Each entry should have keys: file, lines, purpose, exports. "
        f"The JSON must be valid and parseable."
    )
    r = call(prompt)
    if r.get("error"):
        return name, False, f"ERROR: {r['error']}", r

    if not report_file.exists():
        return name, False, "report file not created", r

    try:
        data = json.loads(report_file.read_text())
        if not isinstance(data, list):
            return name, False, "JSON is not an array", r
        if len(data) < 8:
            return name, False, f"only {len(data)} files analyzed (need 8+)", r
        # Validate structure
        required_keys = {"file", "lines", "purpose", "exports"}
        for entry in data:
            if not required_keys.issubset(entry.keys()):
                return name, False, f"missing keys in entry: {entry.get('file','?')}", r
        return name, True, f"{len(data)} files analyzed", r
    except json.JSONDecodeError as e:
        return name, False, f"invalid JSON: {e}", r


def task_web_research():
    """Fetch real URLs and synthesize information."""
    name = "web_research"
    report_file = WORK_DIR / "research.md"
    prompt = (
        f"Research the current state of local LLM inference on Apple Silicon. "
        f"Use WebSearch and WebFetch to find at least 3 real sources. "
        f"Write a markdown report to {report_file} with: "
        f"1. A summary paragraph (3-5 sentences) "
        f"2. A table of tools (llama.cpp, Ollama, MLX, etc.) with columns: Name, GPU Support, Notable Feature "
        f"3. A 'Sources' section listing the actual URLs you fetched. "
        f"The report must be at least 300 words."
    )
    r = call(prompt)
    if r.get("error"):
        return name, False, f"ERROR: {r['error']}", r

    if not report_file.exists():
        return name, False, "report file not created", r

    content = report_file.read_text()
    word_count = len(content.split())
    has_table = "|" in content and "---" in content
    has_sources = "http" in content.lower()
    has_summary = word_count >= 300

    issues = []
    if not has_summary:
        issues.append(f"only {word_count} words (need 300+)")
    if not has_table:
        issues.append("no markdown table found")
    if not has_sources:
        issues.append("no URLs in sources")

    if issues:
        return name, False, "; ".join(issues), r
    return name, True, f"{word_count} words, table + sources present", r


def task_find_and_fix_bug():
    """Plant a bug in a temp file, ask ARIA to find and fix it."""
    name = "find_and_fix_bug"
    bug_file = WORK_DIR / "buggy.ts"
    fixed_file = WORK_DIR / "buggy_fixed.ts"

    # Write a file with a deliberate off-by-one bug
    bug_file.write_text("""\
// Count vowels in a string
export function countVowels(s: string): number {
  const vowels = 'aeiouAEIOU';
  let count = 0;
  // BUG: starts at i=1, skipping the first character
  for (let i = 1; i < s.length; i++) {
    if (vowels.includes(s[i])) count++;
  }
  return count;
}

// Self-test
const tests = [
  { input: 'hello', expected: 2 },
  { input: 'ARIA', expected: 2 },  // should be 3 (A, I, A)
  { input: 'xyz', expected: 0 },
  { input: 'aeiou', expected: 5 },
];

let pass = 0, fail = 0;
for (const t of tests) {
  const got = countVowels(t.input);
  if (got === t.expected) { pass++; console.log(`PASS: "${t.input}" = ${got}`); }
  else { fail++; console.log(`FAIL: "${t.input}" expected=${t.expected} got=${got}`); }
}
console.log(`\\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
""")

    prompt = (
        f"There's a bug in {bug_file}. Run it first to see the failures, "
        f"then find the bug, fix it, save the fixed version to {fixed_file}, "
        f"and run the fixed version to confirm all tests pass. "
        f"Tell me what the bug was and how you fixed it."
    )
    r = call(prompt)
    if r.get("error"):
        return name, False, f"ERROR: {r['error']}", r

    if not fixed_file.exists():
        # Maybe ARIA fixed in-place
        if bug_file.exists():
            fixed_content = bug_file.read_text()
            if "i = 0" in fixed_content or "i=0" in fixed_content:
                return name, True, "fixed in-place (i=1 → i=0)", r

        return name, False, "fixed file not created", r

    # Verify the fix
    try:
        result = subprocess.run(
            ["npx", "--yes", "tsx", str(fixed_file)],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            return name, True, "bug found + fixed + tests pass", r
        return name, False, f"fixed file still fails: {result.stdout[:200]}", r
    except Exception as e:
        return name, False, f"exec error: {e}", r


def task_grep_and_summarize():
    """Search a real codebase for patterns and produce a summary."""
    name = "grep_and_summarize"
    report_file = WORK_DIR / "todos.md"
    prompt = (
        f"Search ~/projects/aria-mac/src/ for all TODO, FIXME, HACK, and XXX comments. "
        f"Use Grep to find them. For each, record the file path, line number, and the comment text. "
        f"Group them by category (TODO vs FIXME vs HACK vs XXX). "
        f"Write a markdown report to {report_file} with a count per category "
        f"and a table listing each finding (file:line, category, comment text). "
        f"If there are zero findings in a category, say so."
    )
    r = call(prompt)
    if r.get("error"):
        return name, False, f"ERROR: {r['error']}", r

    if not report_file.exists():
        return name, False, "report file not created", r

    content = report_file.read_text()
    has_categories = any(cat in content.upper() for cat in ["TODO", "FIXME", "HACK", "XXX"])
    has_table = "|" in content
    has_file_refs = ".ts" in content

    if not has_categories:
        return name, False, "no category breakdown", r
    if not has_table and not has_file_refs:
        return name, False, "no file references or table", r
    return name, True, f"report with categories + file refs ({len(content)} chars)", r


def task_multi_file_refactor():
    """Create multiple files, then ask ARIA to refactor across them."""
    name = "multi_file_refactor"
    src = WORK_DIR / "refactor_src"
    src.mkdir(exist_ok=True)

    # Create 3 files with duplicated helper
    for fname, body in [
        ("math.ts", 'function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }\nexport function normalize(v: number) { return clamp(v, 0, 1); }\n'),
        ("color.ts", 'function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }\nexport function rgbClamp(r: number, g: number, b: number) { return [clamp(r,0,255), clamp(g,0,255), clamp(b,0,255)]; }\n'),
        ("audio.ts", 'function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }\nexport function volumeClamp(v: number) { return clamp(v, 0, 100); }\n'),
    ]:
        (src / fname).write_text(body)

    prompt = (
        f"The directory {src}/ has 3 TypeScript files that all duplicate a `clamp` function. "
        f"Refactor: extract `clamp` into a shared {src}/utils.ts file, then update math.ts, "
        f"color.ts, and audio.ts to import from utils.ts instead of defining their own. "
        f"After refactoring, verify each file is syntactically valid by running "
        f"`npx tsx --eval 'import \"{src}/math.ts\"'` (and same for color.ts, audio.ts)."
    )
    r = call(prompt)
    if r.get("error"):
        return name, False, f"ERROR: {r['error']}", r

    utils = src / "utils.ts"
    if not utils.exists():
        return name, False, "utils.ts not created", r

    utils_content = utils.read_text()
    if "clamp" not in utils_content:
        return name, False, "utils.ts doesn't contain clamp", r

    # Check the 3 files import from utils
    deduped = 0
    for fname in ["math.ts", "color.ts", "audio.ts"]:
        content = (src / fname).read_text()
        has_import = "import" in content and "utils" in content
        no_local_clamp = content.count("function clamp") == 0
        if has_import and no_local_clamp:
            deduped += 1

    if deduped >= 2:
        return name, True, f"{deduped}/3 files deduplicated", r
    return name, False, f"only {deduped}/3 files updated", r


def task_data_pipeline():
    """Generate CSV data, ask ARIA to analyze and produce stats."""
    name = "data_pipeline"
    import csv, random

    csv_file = WORK_DIR / "sales.csv"
    report_file = WORK_DIR / "sales_report.json"

    # Generate deterministic test data
    rng = random.Random(42)
    regions = ["North", "South", "East", "West"]
    rows = []
    for i in range(100):
        region = regions[i % 4]
        amount = rng.randint(100, 9999)
        rows.append({"id": i + 1, "region": region, "amount": amount})

    with open(csv_file, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["id", "region", "amount"])
        w.writeheader()
        w.writerows(rows)

    # Pre-compute expected answers
    by_region: dict[str, list[int]] = {}
    for row in rows:
        by_region.setdefault(row["region"], []).append(row["amount"])
    expected_totals = {r: sum(v) for r, v in by_region.items()}
    expected_top_region = max(expected_totals, key=expected_totals.get)
    expected_grand_total = sum(r["amount"] for r in rows)

    prompt = (
        f"Read the CSV file at {csv_file} (columns: id, region, amount). "
        f"Compute: total amount per region, the region with highest total, "
        f"and the grand total across all regions. "
        f"Write results to {report_file} as JSON with keys: "
        f"by_region (object mapping region→total), top_region (string), grand_total (number). "
        f"Use Bash or Read tool — do NOT guess the data."
    )
    r = call(prompt)
    if r.get("error"):
        return name, False, f"ERROR: {r['error']}", r

    if not report_file.exists():
        return name, False, "report file not created", r

    try:
        data = json.loads(report_file.read_text())
    except json.JSONDecodeError as e:
        return name, False, f"invalid JSON: {e}", r

    issues = []
    if data.get("top_region") != expected_top_region:
        issues.append(f"top_region: got {data.get('top_region')}, expected {expected_top_region}")
    if data.get("grand_total") != expected_grand_total:
        issues.append(f"grand_total: got {data.get('grand_total')}, expected {expected_grand_total}")
    # Check per-region totals (allow ±1 for rounding)
    br = data.get("by_region", {})
    for region, expected in expected_totals.items():
        got = br.get(region, 0)
        if abs(got - expected) > 1:
            issues.append(f"{region}: got {got}, expected {expected}")

    if issues:
        return name, False, "; ".join(issues[:3]), r
    return name, True, f"all values correct (grand_total={expected_grand_total})", r


def task_iterative_debug():
    """Give ARIA a failing test + implementation, make it iterate until green."""
    name = "iterative_debug"
    impl_file = WORK_DIR / "parser.ts"
    test_file = WORK_DIR / "parser_test.ts"

    # Write a broken implementation
    impl_file.write_text("""\
// Parse "key=value" pairs from a string like "name=Alice age=30 city=Paris"
export function parseKV(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  // BUG 1: splits on comma instead of space
  const pairs = input.split(',');
  for (const pair of pairs) {
    // BUG 2: splits on ':' instead of '='
    const [key, value] = pair.split(':');
    if (key && value) {
      result[key.trim()] = value.trim();
    }
  }
  return result;
}
""")

    test_file.write_text(f"""\
import {{ parseKV }} from '{impl_file.with_suffix("")}';

const tests = [
  {{ input: 'name=Alice age=30', expected: {{ name: 'Alice', age: '30' }} }},
  {{ input: 'x=1 y=2 z=3', expected: {{ x: '1', y: '2', z: '3' }} }},
  {{ input: 'key=value', expected: {{ key: 'value' }} }},
  {{ input: '', expected: {{}} }},
];

let pass = 0, fail = 0;
for (const t of tests) {{
  const got = parseKV(t.input);
  const ok = JSON.stringify(got) === JSON.stringify(t.expected);
  if (ok) {{ pass++; console.log(`PASS: "${{t.input}}"`); }}
  else {{ fail++; console.log(`FAIL: "${{t.input}}" expected=${{JSON.stringify(t.expected)}} got=${{JSON.stringify(got)}}`); }}
}}
console.log(`\\n${{pass}} pass, ${{fail}} fail`);
if (fail > 0) process.exit(1);
""")

    prompt = (
        f"The file {impl_file} has a parseKV function with bugs. "
        f"Run the test file at {test_file} to see what fails. "
        f"Fix the implementation in {impl_file} (NOT the tests) until ALL tests pass. "
        f"You may need to iterate — run tests, fix, run again. "
        f"Tell me what bugs you found and fixed."
    )
    r = call(prompt)
    if r.get("error"):
        return name, False, f"ERROR: {r['error']}", r

    # Verify by running the test ourselves
    try:
        result = subprocess.run(
            ["npx", "--yes", "tsx", str(test_file)],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            return name, True, "both bugs fixed, all tests pass", r
        output = (result.stdout + result.stderr)[:300]
        return name, False, f"tests still fail: {output}", r
    except Exception as e:
        return name, False, f"exec error: {e}", r


# ─── Runner ──────────────────────────────────────────────────────────────────

TASKS = [
    ("build_and_test", task_build_and_test_script),
    ("codebase_analysis", task_codebase_analysis),
    ("web_research", task_web_research),
    ("find_and_fix_bug", task_find_and_fix_bug),
    ("grep_and_summarize", task_grep_and_summarize),
    ("multi_file_refactor", task_multi_file_refactor),
    ("data_pipeline", task_data_pipeline),
    ("iterative_debug", task_iterative_debug),
]


def main() -> int:
    # Allow running a single task via env
    only = os.environ.get("TASK")
    if only:
        tasks = [(n, f) for n, f in TASKS if n == only]
        if not tasks:
            print(f"Unknown task: {only}. Available: {[n for n, _ in TASKS]}")
            return 1
    else:
        tasks = TASKS

    clean_workdir()
    results = []
    total_start = time.time()

    for i, (task_name, task_fn) in enumerate(tasks, 1):
        print(f"\n[{i}/{len(tasks)}] {task_name}")
        t0 = time.time()
        try:
            name, passed, detail, resp = task_fn()
        except Exception as e:
            name, passed, detail, resp = task_name, False, f"EXCEPTION: {e}", {}
        elapsed = time.time() - t0
        icon = "✅" if passed else "❌"
        print(f"  {icon} {detail} ({elapsed:.1f}s)")
        results.append({
            "name": name,
            "passed": passed,
            "detail": detail,
            "elapsed_s": round(elapsed, 1),
            "reply_len": len(resp.get("reply", "")),
            "task_type": resp.get("taskType", ""),
        })

    total_elapsed = time.time() - total_start
    passed = sum(1 for r in results if r["passed"])
    total = len(results)

    print(f"\n{'='*60}")
    print(f"  PASSED: {passed}/{total} ({100*passed//total}%)")
    print(f"  TOTAL TIME: {total_elapsed:.0f}s ({total_elapsed/60:.1f} min)")
    print(f"  WORK DIR: {WORK_DIR}")

    report = {
        "bench": "10-long-tasks",
        "backend": BACKEND,
        "passed": passed,
        "total": total,
        "elapsed_s": round(total_elapsed, 1),
        "results": results,
        "timestamp": int(time.time()),
    }
    out = Path(f"/tmp/aria-bench-10-{int(time.time())}.json")
    out.write_text(json.dumps(report, indent=2))
    print(f"  Report: {out}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
