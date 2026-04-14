#!/usr/bin/env python3
"""Live test ARIA — sequential, waits for each response, logs to stdout."""
import json, urllib.request, urllib.error, time, sys

ARIA_URL = "http://127.0.0.1:3100/api/dashboard/send"
TIMEOUT = 240  # 4 min per test max

TESTS = [
    # ─── 1-10: Greetings / simple ─────────────────────────────
    ("Hi there, quick check — are you online?", "chat"),
    ("Good morning", "chat"),
    ("What's 5 + 7?", "chat"),
    ("Tell me your name in one word", "chat"),
    ("Thanks, that's helpful", "chat"),
    ("What model powers you?", "chat"),
    ("Are you local or in the cloud?", "chat"),
    ("Say something funny", "chat"),
    ("How are you feeling?", "chat"),
    ("Nice to meet you", "chat"),

    # ─── 11-20: Memory/factual recall ────────────────────────
    ("Who am I?", "chat"),
    ("Do you know about EasyBee?", "chat"),
    ("What's Henry's blog URL?", "chat"),
    ("Am I a no-code user?", "chat"),
    ("What timezone am I in?", "chat"),
    ("Did I submit EasyBee to the App Store?", "chat"),
    ("Do you have access to image generation?", "chat"),
    ("What's my Mac Studio's RAM?", "chat"),
    ("What projects do I have?", "chat"),
    ("Do you know the youtube-learn skill?", "chat"),

    # ─── 21-30: Filesystem operations ────────────────────────
    ("How many .ts files in /Users/hungpham/projects/aria-mac/src?", "chat"),
    ("Read the first 5 lines of /Users/hungpham/projects/aria-mac/package.json", "chat"),
    ("Check if /tmp/aria-test-live-1.txt exists", "chat"),
    ("Create /tmp/aria-test-live-1.txt with content 'test 23'", "simple-task"),
    ("Read back /tmp/aria-test-live-1.txt", "chat"),
    ("Delete /tmp/aria-test-live-1.txt", "simple-task"),
    ("List files in /Users/hungpham/.claude/skills/", "chat"),
    ("What's in /Users/hungpham/projects/aria-mac/.env.example?", "chat"),
    ("Find .json files in /Users/hungpham/projects/aria-mac/data/", "chat"),
    ("What's the largest file under /Users/hungpham/projects/aria-mac/src/?", "chat"),

    # ─── 31-40: Code understanding ───────────────────────────
    ("How many lines in /Users/hungpham/projects/aria-mac/src/aria/core.ts?", "chat"),
    ("What does classifyTask do? Read task-runner.ts briefly", "chat"),
    ("What tools does ARIA have? Just list names", "chat"),
    ("Grep for 'ephemeral' in /Users/hungpham/projects/aria-mac/src/", "chat"),
    ("What are the 3 severity levels in quality-judge.ts?", "chat"),
    ("Read aria-identity.md and tell me my name according to it", "chat"),
    ("What's the default agent model in .env.local?", "chat"),
    ("Find where runTask is defined", "chat"),
    ("What does validatePlan check for?", "chat"),
    ("What's the MAX_CONCURRENT_AGENTS value?", "chat"),

    # ─── 41-50: Math / reasoning ─────────────────────────────
    ("What's 23 * 17?", "chat"),
    ("If I commit 3x per day for 2 weeks, how many commits?", "chat"),
    ("Convert 3600 seconds to hours:minutes", "chat"),
    ("What's larger: 2^10 or 1050?", "chat"),
    ("If gemma4:26b is 16GB and Mac has 36GB, % used?", "chat"),
    ("Sort these numbers: 47, 3, 22, 8, 15", "chat"),
    ("What's 50% off $9.99?", "chat"),
    ("How many days from Apr 14 to Dec 31 in 2026?", "chat"),
    ("If ARIA uses 20 tokens/sec and needs 2000 tokens, seconds?", "chat"),
    ("Monthly cost if $9.99/mo billed yearly?", "chat"),

    # ─── 51-60: Task execution ───────────────────────────────
    ("Create a directory at /tmp/aria-live-dir", "simple-task"),
    ("Write 'hello live test' to /tmp/aria-live-dir/note.txt", "simple-task"),
    ("Read back /tmp/aria-live-dir/note.txt", "chat"),
    ("Count lines in /tmp/aria-live-dir/note.txt", "chat"),
    ("Run date command and tell me the result", "chat"),
    ("Run: echo test | wc -c", "chat"),
    ("Check process count running on my Mac", "chat"),
    ("Get the hostname of this Mac", "chat"),
    ("Check free RAM", "chat"),
    ("Cleanup: delete /tmp/aria-live-dir recursively", "simple-task"),

    # ─── 61-70: Debug scenarios ──────────────────────────────
    ("The file /tmp/aria-nonexistent-xyz.txt is missing, can you check why?", "debug-task"),
    ("Check if Ollama is responsive", "debug-task"),
    ("Is there something wrong with the quality judge?", "debug-task"),
    ("Verify all ARIA's required services are running", "chat"),
    ("Check my .env.local for any issues", "debug-task"),
    ("Is the ARIA database accessible?", "chat"),
    ("Check if Telegram bot token is configured", "chat"),
    ("Why might ARIA be slow? Check logs", "debug-task"),
    ("Verify Gemini API key isn't required", "chat"),
    ("Check disk space and warn me if low", "chat"),

    # ─── 71-80: Skills / specific knowledge ──────────────────
    ("What does the youtube-learn skill do?", "chat"),
    ("How do I use the henry-blog-post skill?", "chat"),
    ("What skills do I have available?", "chat"),
    ("What's the godot-3d-pixel-art skill for?", "chat"),
    ("Can you generate images? What tool?", "chat"),
    ("Can you take screenshots of websites?", "chat"),
    ("How does the task runner handle failures?", "chat"),
    ("What's the difference between simple-task and complex-task?", "chat"),
    ("How long do background agents run max?", "chat"),
    ("What's the 3-nudge cap in continuation detection?", "chat"),

    # ─── 81-90: Follow-up / context-aware ────────────────────
    ("What was the first question I asked you in this session?", "chat"),
    ("I said I had 7 projects earlier — was that true?", "chat"),
    ("Remember what model I asked about earlier?", "chat"),
    ("My favorite color is orange. What did I just say?", "chat"),
    ("Did we talk about EasyBee?", "chat"),
    ("What skill did I ask about last?", "chat"),
    ("Summarize our last 3 exchanges briefly", "chat"),
    ("I mentioned a sprint — when does it end again?", "chat"),
    ("How many tests have I run in this session approximately?", "chat"),
    ("What's been the theme of our conversation?", "chat"),

    # ─── 91-100: Edge cases ──────────────────────────────────
    ("", "chat"),  # empty
    ("?", "chat"),
    ("ok", "chat"),
    ("please", "chat"),
    ("tell me about banana bread recipes", "chat"),  # off-topic
    ("What is quantum entanglement in one sentence?", "chat"),
    ("Who won the 2024 World Cup?", "chat"),  # knowledge cutoff
    ("🤖🚀🎉", "chat"),  # emoji only
    ("The quick brown fox jumps over the lazy dog repeatedly for many words to test long input handling without any tool calls just conversation natural chat to see how the model handles verbose input without action", "chat"),
    ("Okay final test — say goodbye", "chat"),
]

def run_test(i, prompt, expected_type):
    start = time.time()
    try:
        req = urllib.request.Request(
            ARIA_URL,
            data=json.dumps({"message": prompt or "(empty)"}).encode('utf-8'),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            data = json.loads(r.read().decode('utf-8'))
            elapsed = data.get('elapsed', '?')
            task_type = data.get('taskType', '?')
            reply = data.get('reply', '') or data.get('error', '')
            elapsed_real = time.time() - start

            # Judge pass/fail heuristically
            has_response = bool(reply and len(reply.strip()) > 2)
            has_error = 'error' in reply.lower()[:100] if reply else False
            status = "✅" if has_response and not has_error else "❌"

            print(f"\n[{i:3}/100] {status} {elapsed}s · {task_type}")
            print(f"  →  {prompt[:100]}")
            print(f"  ←  {reply[:200]}")
            return {"i": i, "prompt": prompt, "reply": reply, "elapsed": elapsed, "taskType": task_type, "pass": status == "✅"}
    except urllib.error.URLError as e:
        elapsed_real = time.time() - start
        print(f"\n[{i:3}/100] ❌ {elapsed_real:.1f}s · URLError")
        print(f"  →  {prompt[:100]}")
        print(f"  ←  {str(e)[:150]}")
        return {"i": i, "prompt": prompt, "reply": "", "error": str(e), "pass": False, "elapsed_real": elapsed_real}
    except Exception as e:
        elapsed_real = time.time() - start
        print(f"\n[{i:3}/100] ❌ {elapsed_real:.1f}s · {type(e).__name__}")
        print(f"  →  {prompt[:100]}")
        print(f"  ←  {str(e)[:150]}")
        return {"i": i, "prompt": prompt, "reply": "", "error": str(e), "pass": False, "elapsed_real": elapsed_real}

def main():
    # Allow offset to resume
    start_from = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    end_at = int(sys.argv[2]) if len(sys.argv) > 2 else 100

    print(f"\n╔══════════════════════════════════════════╗")
    print(f"║  ARIA Live Battle Test (sequential)       ║")
    print(f"║  Tests {start_from}-{end_at} of 100                      ║")
    print(f"╚══════════════════════════════════════════╝")

    results = []
    for i in range(start_from, end_at + 1):
        if i > len(TESTS):
            break
        prompt, expected = TESTS[i - 1]
        result = run_test(i, prompt, expected)
        results.append(result)
        # Small delay to let dashboard breathe
        time.sleep(1)

    # Save results
    out = f"/tmp/aria-live-results-{int(time.time())}.json"
    with open(out, 'w') as f:
        json.dump(results, f, indent=2)

    passed = sum(1 for r in results if r.get('pass'))
    print(f"\n{'═'*50}")
    print(f"  PASSED: {passed}/{len(results)} ({passed/len(results)*100:.1f}%)")
    print(f"  Report: {out}")

if __name__ == '__main__':
    main()
