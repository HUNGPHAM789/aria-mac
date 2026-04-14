#!/usr/bin/env python3
"""Run all ARIA benchmark suites and produce a consolidated report."""
import subprocess, json, time, sys, os
from pathlib import Path

BENCH_DIR = Path(__file__).parent
SUITES = [
    ("01-basic-100.py", "Basic (100 tests)"),
    ("02-complex-40.py", "Complex (40 tests)"),
    ("03-diagnosis-10.py", "Diagnosis (10 tests)"),
    ("04-coding-10.py", "Advanced Coding (10 tests)"),
]

# Verify ARIA is up
try:
    import urllib.request
    urllib.request.urlopen("http://127.0.0.1:3100/api/sessions", timeout=3)
except Exception:
    print("ERROR: ARIA not running at http://127.0.0.1:3100")
    print("Start with: cd /Users/hungpham/projects/aria-mac && npm run aria")
    sys.exit(1)

# Snapshot git state before
git_before = subprocess.check_output(
    ["git", "rev-parse", "HEAD"], cwd=BENCH_DIR.parent
).decode().strip()
git_status_before = subprocess.check_output(
    ["git", "status", "--porcelain", "src/", "identity/", "package.json"],
    cwd=BENCH_DIR.parent
).decode()

print(f"\n{'═'*60}")
print(f"  ARIA FULL BENCHMARK SUITE")
print(f"  Git: {git_before[:12]}")
print(f"  Source state: {'clean' if not git_status_before.strip() else 'modified (will detect post-run drift)'}")
print(f"{'═'*60}\n")

started = time.time()
suite_results = []

for script, label in SUITES:
    print(f"\n>>> {label} <<<\n")
    suite_start = time.time()
    result = subprocess.run(
        [sys.executable, str(BENCH_DIR / script)],
        capture_output=False  # let it stream to stdout for live visibility
    )
    suite_elapsed = time.time() - suite_start
    suite_results.append({
        "suite": label,
        "script": script,
        "exit_code": result.returncode,
        "elapsed_s": round(suite_elapsed, 1),
    })

# Check post-run git state for safety regressions
git_status_after = subprocess.check_output(
    ["git", "status", "--porcelain", "src/", "identity/", "package.json"],
    cwd=BENCH_DIR.parent
).decode()

safety_regression = git_status_after != git_status_before

total_elapsed = time.time() - started

print(f"\n{'═'*60}")
print(f"  CONSOLIDATED REPORT")
print(f"{'═'*60}")
for r in suite_results:
    print(f"  {r['suite']:35} {r['elapsed_s']:>7.1f}s  exit={r['exit_code']}")
print(f"  {'TOTAL':35} {total_elapsed:>7.1f}s")
print(f"\nSafety regression check (source modifications during tests):")
if safety_regression:
    print(f"  ⚠️  WARNING: Source files modified during run!")
    print(f"  Diff:\n{git_status_after}")
else:
    print(f"  ✅ No source modifications detected")
print(f"\nIndividual reports in /tmp/aria-*-results-*.json")
