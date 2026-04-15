#!/usr/bin/env python3
"""
Benchmark 08: Long-horizon compaction stress test.

Fires a synthetic 60-turn conversation that deliberately exceeds the 60K-token
compaction threshold mid-run, then probes whether the final answer still
retrieves facts from the EARLY turns — i.e. whether Track C compaction
preserved them through the summary step.

Methodology:
  1. Plant FACT_A in turn 1 (e.g. "My lucky number is 47392").
  2. Fill turns 2-N with padding content to push tokens past 60K.
  3. Plant FACT_B in turn N-5.
  4. Ask about both facts in the final turn.
  5. Score: {both | only_recent | neither}.

Each fact is a random 5-digit integer so the model can't guess.
"""
import json, os, random, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from backends import get_backend

BACKEND_NAME = os.environ.get("BACKEND", "aria")
NUM_FILLER_TURNS = int(os.environ.get("FILLER_TURNS", "58"))
FILLER_CHARS = int(os.environ.get("FILLER_CHARS", "1500"))   # per turn
TIMEOUT = int(os.environ.get("TURN_TIMEOUT", "180"))

# Use a fixed thread so successive POSTs share history server-side.
# (ARIA's /api/dashboard/send writes to thread 'claude:live-test' by default.)
# Scoring rubric:
#   both         = retrieved both facts verbatim                    → PASS
#   only_recent  = retrieved only the most recent fact              → partial
#   neither      = lost both facts                                  → FAIL


def make_padding(i: int) -> str:
    # Deterministic padding so runs are reproducible per seed.
    rng = random.Random(i)
    topics = ['coffee brewing', 'TypeScript generics', 'Celtic knots',
              'volcanic glass', 'tax accounting', 'bird migration',
              'tide pooling', 'Sanskrit grammar', 'stellar parallax']
    topic = rng.choice(topics)
    body = ' '.join(rng.choices(
        ['the', 'and', 'bread', 'light', 'iron', 'quiet', 'reflective',
         'porous', 'angular', 'dense', 'supple', 'brittle', 'cold',
         'humid', 'specific', 'abstract', 'layered', 'shallow'],
        k=FILLER_CHARS // 8,
    ))
    return f"[Turn {i} — {topic}] {body}"


def main() -> int:
    call = get_backend(BACKEND_NAME)
    rng = random.Random(int(time.time()))
    fact_a = rng.randint(10000, 99999)
    fact_b = rng.randint(10000, 99999)
    print(f"  FACT_A={fact_a}  FACT_B={fact_b}  backend={BACKEND_NAME}")

    # Turn 1 — plant FACT_A
    t0 = time.time()
    r = call(f"Remember this number: FACT_A is {fact_a}. Acknowledge briefly.", timeout=TIMEOUT)
    if r.get("error"):
        print(f"  turn 1 ERROR: {r['error']}"); return 1
    print(f"  [1/{NUM_FILLER_TURNS+3}] plant FACT_A ({time.time()-t0:.1f}s)")

    # Turns 2..N-1 — filler to push past 60K
    for i in range(2, NUM_FILLER_TURNS + 2):
        pad = make_padding(i)
        t0 = time.time()
        r = call(f"Note this for later reference (no action needed): {pad}", timeout=TIMEOUT)
        elapsed = time.time() - t0
        if r.get("error"):
            print(f"  turn {i} ERROR: {r['error']}")
            return 2
        # Light progress dot every 10 turns
        if i % 10 == 0:
            print(f"  [{i}/{NUM_FILLER_TURNS+3}] filler ({elapsed:.1f}s)")

    # Turn N+2 — plant FACT_B (after compaction should already have fired)
    t0 = time.time()
    r = call(f"Also remember: FACT_B is {fact_b}. Acknowledge briefly.", timeout=TIMEOUT)
    if r.get("error"):
        print(f"  plant FACT_B ERROR: {r['error']}"); return 3
    print(f"  [{NUM_FILLER_TURNS+2}/{NUM_FILLER_TURNS+3}] plant FACT_B ({time.time()-t0:.1f}s)")

    # Final probe
    probe = ("What were FACT_A and FACT_B? Answer with both numbers on separate "
             "lines. If you do not know one, say 'unknown' for that one.")
    t0 = time.time()
    r = call(probe, timeout=TIMEOUT)
    elapsed = time.time() - t0
    if r.get("error"):
        print(f"  probe ERROR: {r['error']}"); return 4
    reply = r.get("reply", "")
    print(f"  [{NUM_FILLER_TURNS+3}/{NUM_FILLER_TURNS+3}] probe ({elapsed:.1f}s)")
    print(f"  --- reply ---\n{reply[:800]}\n  ---")

    has_a = str(fact_a) in reply
    has_b = str(fact_b) in reply

    verdict = "both" if (has_a and has_b) else ("only_recent" if has_b else ("only_old" if has_a else "neither"))
    passed = verdict == "both"
    print()
    print(f"  FACT_A recovered: {'✅' if has_a else '❌'}")
    print(f"  FACT_B recovered: {'✅' if has_b else '❌'}")
    print(f"  VERDICT: {verdict}  ({'PASS' if passed else 'FAIL'})")

    report = {
        "backend": BACKEND_NAME,
        "filler_turns": NUM_FILLER_TURNS,
        "filler_chars": FILLER_CHARS,
        "fact_a": fact_a, "fact_b": fact_b,
        "has_a": has_a, "has_b": has_b,
        "verdict": verdict, "passed": passed,
        "final_reply": reply,
        "timestamp": int(time.time()),
    }
    out = Path("/tmp") / f"aria-long-horizon-{int(time.time())}.json"
    out.write_text(json.dumps(report, indent=2))
    print(f"  Report: {out}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
