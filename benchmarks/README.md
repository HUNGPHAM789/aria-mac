# ARIA Benchmarks

Regression test suite for ARIA (JarvisM4). Tests run against a live ARIA instance via the dashboard HTTP endpoint.

## Prerequisites

ARIA must be running:
```bash
npm run aria
```

Verify:
```bash
curl http://127.0.0.1:3100/api/sessions
```

## Test Suites

| Suite | Tests | Coverage | Avg Time | Last Pass Rate |
|-------|-------|----------|----------|----------------|
| `01-basic-100.py` | 100 | Greetings, memory, simple tasks, file ops, math, debug, skills, edge cases | ~30 min | 97% (97/100) |
| `02-complex-40.py` | 40 | GitHub research, HuggingFace, Playwright, debug, coding, reasoning | ~60 min | 87.5% (35/40) |
| `03-diagnosis-10.py` | 10 | Read-only investigations, multi-file scans | ~5 min | **100%** (10/10) |
| `04-coding-10.py` | 10 | Architecture, refactor proposals, bug hunting, metrics | ~10 min | **100%** (10/10) |
| `05-function-calling-10.py` | 10 | BFCL-inspired: tool selection, over-/under-tooling, efficiency | ~2 min | **100%** (10/10) |
| `06-gaia-lite-10.py` | 10 | GAIA-inspired: verifiable single-answer questions (substring/regex grading) | ~1 min | **100%** (10/10) |
| `07-hard-20.py` | 20 | Frontier battle: false-premise, adversarial noise, code synthesis w/ exec, planning tradeoffs, ambiguity, refusal calibration | ~15 min | 25% (5/20) — diagnostic baseline |

## Running

```bash
# Single suite
python3 benchmarks/01-basic-100.py

# Range within a suite
python3 benchmarks/01-basic-100.py 1 20    # tests 1-20 only
python3 benchmarks/02-complex-40.py 25 35  # tests 25-35 only

# All suites (sequential, ~2 hours)
for f in benchmarks/0*-*.py; do
  echo "═══ $f ═══"
  python3 "$f"
done
```

## What These Benchmarks Measure

**Reliability:**
- Does ARIA respond at all?
- Does it complete the task vs go silent?
- Does it have ✅/❌ completion markers?

**Routing accuracy:**
- "Check X" → `analysis-task` (read-only, safe)
- "Fix X" → `debug-task` (diagnose-fix-verify)
- "Write a blog post" → `complex-task` (plan mode)
- "What's 2+2" → `chat`

**Latency per category:**
- Chat: < 5s
- Simple task: < 30s
- Complex task: 60-180s (plan mode adds overhead)
- Debug task: 120-300s (3 cycles max)

**Safety regressions:**
- ARIA must NOT modify its own source code
- ARIA must NOT run `git restore` on itself
- ARIA must NOT `npm install` on its own deps
- Tracked via `git status` after each suite

## Result Format

Each script saves a JSON report to `/tmp/aria-*-results-{timestamp}.json` with:
- Per-test: prompt, reply, elapsed, taskType, pass/fail, failures
- Summary: pass count, by-category breakdown, total time

## When to Run

- **Before committing changes** to runner / classifier / core loop
- **After upgrading Ollama or gemma4 model**
- **After identity prompt changes**
- **Periodically** to catch model drift

## Known Issues

- `01-basic-100.py` tests 5, 6, 9, 11, 16, 20 occasionally return empty due to Ollama load — run individually if flaky
- Complex tests stress Ollama on Mac M4 36GB — keep ComfyUI/heavy apps off during runs
- Tests with very long prompts (>200 chars) can trigger plan mode unexpectedly
