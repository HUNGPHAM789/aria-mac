#!/usr/bin/env python3
"""40 Advanced ARIA Tests — complexity-heavy."""
import json, urllib.request, urllib.error, time, sys

ARIA_URL = "http://127.0.0.1:3100/api/dashboard/send"
TIMEOUT = 300  # 5 min per test max

TESTS = [
    # ─── GitHub Research (8 tests) ────────────────────────────────────
    ("Use WebFetch to grab https://github.com/HUNGPHAM789/aria-mac and tell me how many stars the repo has", "research"),
    ("Fetch https://api.github.com/repos/HUNGPHAM789/aria-mac and tell me the created_at date, language, default branch", "research"),
    ("Use WebFetch on https://github.com/ollama/ollama and list 3 key features you can see", "research"),
    ("Research https://github.com/pytorch/pytorch — when was it created, what's the star count roughly, what's the language breakdown?", "research"),
    ("Compare 2 Telegram bot libraries for Node: fetch https://github.com/telegraf/telegraf and https://github.com/yagop/node-telegram-bot-api. Which is more active?", "research"),
    ("Find the top 5 Playwright-related repos via Tavily WebSearch 'playwright automation best repos 2026'", "research"),
    ("Look at https://github.com/anthropics/anthropic-sdk-typescript — what's its latest release?", "research"),
    ("Search for 'local LLM agent framework' on Tavily and list 3 top results", "research"),

    # ─── HuggingFace Research (5 tests) ───────────────────────────────
    ("Use WebFetch on https://huggingface.co/google/gemma-4-26b to describe the model", "research"),
    ("Fetch https://huggingface.co/models?search=lipsync and tell me the top 3 lipsync models", "research"),
    ("Get https://huggingface.co/nomic-ai/nomic-embed-text-v1.5 — what's the embedding dimension?", "research"),
    ("Search HuggingFace for 'small code model local' via WebFetch and recommend one", "research"),
    ("Compare gemma-4-26b vs llama-3-8b via HF pages — which would be better for tool calling on Mac M4 36GB?", "research"),

    # ─── Upgrade Proposals (5 tests) ──────────────────────────────────
    ("Research what 'prompt caching' means in Claude API via WebFetch on Anthropic docs, then propose how ARIA could implement something similar", "research"),
    ("Research the Model Context Protocol (MCP) spec at https://modelcontextprotocol.io and propose how ARIA could become an MCP client", "research"),
    ("Compare current ARIA architecture (plan-execute-verify loop) vs ReAct pattern and propose which is better for gemma4:26b", "research"),
    ("Research 'agentic RAG' 2026 techniques and propose 2 upgrades for ARIA's memory system", "research"),
    ("Based on our conversation context, propose 3 specific improvements to ARIA's task runner that would help reliability", "research"),

    # ─── Playwright Advanced (6 tests) ────────────────────────────────
    ("Use Browser tool to navigate to https://example.com and screenshot it. Tell me the page title.", "browser"),
    ("Navigate to https://news.ycombinator.com and extract the top 3 story titles from the rendered page", "browser"),
    ("Go to https://github.com/HUNGPHAM789/aria-mac, take a full-page screenshot, and tell me approximately how many files are visible", "browser"),
    ("Use Browser on https://duckduckgo.com — type 'ollama gemma4' into the search box and press Enter, then report top result", "browser"),
    ("Navigate to https://httpbin.org/forms/post. Fill the 'custname' field with 'JarvisM4', select 'large' for size. Take screenshot.", "browser"),
    ("Test hungpham789.github.io/henrys-blog/ — extract the latest 2 blog post titles", "browser"),

    # ─── Complex Multi-Step Diagnosis (6 tests) ────────────────────────
    ("Boss reported ARIA is slow. Diagnose: check Ollama load, memory usage, running processes, recent log errors. Report root cause.", "debug"),
    ("Check if there's a memory leak in ARIA. Look at process RSS over time, check DB size, check log growth.", "debug"),
    ("The quality judge shows slow_response issues. Trace: find slow requests in logs, correlate with what was happening.", "debug"),
    ("Some messages aren't being saved to DB. Investigate: check DB schema, check recent messages, check if ephemeral flag is misused.", "debug"),
    ("ARIA Telegram bot sometimes misses messages. Diagnose: check polling config, check bot.launch retries, check Telegraf version.", "debug"),
    ("Diagnose why the debug runner might modify source code: trace the prompts in task-runner.ts, find the dangerous pattern.", "debug"),

    # ─── Advanced Coding (5 tests) ────────────────────────────────────
    ("Read /Users/hungpham/projects/aria-mac/src/aria/quality-judge.ts. Propose a new quality check (just describe it, don't modify code).", "coding"),
    ("Find all TypeScript files with `any` type in /Users/hungpham/projects/aria-mac/src/ and list them.", "coding"),
    ("Look at the task-runner.ts runDebugTask function. Describe its control flow and find any potential infinite loop.", "coding"),
    ("Scan the entire src/ for TODO / FIXME / HACK comments. Group them and prioritize.", "coding"),
    ("Review the agentic loop in core.ts runClaude. Find 2 places where errors could silently swallow information.", "coding"),

    # ─── Reasoning / Planning (5 tests) ───────────────────────────────
    ("If I want to ship 5 features in 2 weeks (10 working days), and each takes 1-3 days, how should I sequence them to minimize risk?", "reasoning"),
    ("Compare approaches for adding MCP support to ARIA: (A) fork and extend, (B) write MCP client from scratch, (C) wait for Ollama to add. Recommend.", "reasoning"),
    ("If EasyBee gets rejected by Apple review, what's the triage sequence? Order actions by priority.", "reasoning"),
    ("Given ARIA runs on Mac M4 36GB, what's the hardware bottleneck and what would it take to double throughput?", "reasoning"),
    ("I want to A/B test gemma4:26b vs a hypothetical gemma4:8b. Design a 5-step experiment I can run on my Mac this weekend.", "reasoning"),

    # ─── Integration / Tool Chain (5 tests) ───────────────────────────
    ("Research what a Langchain Agent is via WebFetch, take a screenshot of the docs page, and propose if ARIA should adopt anything from it", "integration"),
    ("Use Browser to check https://hungpham789.github.io/henrys-blog/posts/aria-autopilot-teaching-local-ai-to-finish-tasks.html and verify the page loads with styling", "integration"),
    ("Find the latest ARIA commit on GitHub (via API), read the commit message, and summarize what was committed", "integration"),
    ("Research current state of Local LLM agents in April 2026 (via Tavily), then compare to ARIA, then propose what's missing", "integration"),
    ("Take a screenshot of your own dashboard at http://127.0.0.1:3100/ and tell me what sessions are visible", "integration"),
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
            has_response = bool(reply and len(reply.strip()) > 20)
            has_error = reply.lower().startswith('error:') if reply else True
            status = "✅" if has_response and not has_error else "❌"
            print(f"\n[{i:2}/40] {status} {elapsed}s · {task_type} · {category}")
            print(f"  →  {prompt[:110]}")
            print(f"  ←  {reply[:300]}")
            return {"i": i, "category": category, "prompt": prompt, "reply": reply, "elapsed": elapsed, "taskType": task_type, "pass": status == "✅"}
    except urllib.error.URLError as e:
        el = time.time() - start
        print(f"\n[{i:2}/40] ❌ {el:.1f}s · URLError · {category}")
        print(f"  →  {prompt[:110]}")
        print(f"  ←  {str(e)[:200]}")
        return {"i": i, "category": category, "prompt": prompt, "error": str(e), "pass": False}
    except Exception as e:
        el = time.time() - start
        print(f"\n[{i:2}/40] ❌ {el:.1f}s · {type(e).__name__} · {category}")
        print(f"  →  {prompt[:110]}")
        print(f"  ←  {str(e)[:200]}")
        return {"i": i, "category": category, "prompt": prompt, "error": str(e), "pass": False}

def main():
    start_from = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    end_at = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    print(f"\n╔══════════════════════════════════════════╗")
    print(f"║  ARIA Complexity Battle Test              ║")
    print(f"║  Tests {start_from}-{end_at}                              ║")
    print(f"╚══════════════════════════════════════════╝")
    results = []
    for i in range(start_from, end_at + 1):
        if i > len(TESTS): break
        prompt, category = TESTS[i - 1]
        result = run_test(i, prompt, category)
        results.append(result)
        time.sleep(3)  # Longer delay for complex tests
    out = f"/tmp/aria-complex-results-{int(time.time())}.json"
    with open(out, 'w') as f: json.dump(results, f, indent=2)
    passed = sum(1 for r in results if r.get('pass'))
    by_cat = {}
    for r in results:
        cat = r.get('category', 'unknown')
        if cat not in by_cat: by_cat[cat] = {'pass': 0, 'fail': 0}
        if r.get('pass'): by_cat[cat]['pass'] += 1
        else: by_cat[cat]['fail'] += 1
    print(f"\n{'═'*60}")
    print(f"  PASSED: {passed}/{len(results)} ({passed/len(results)*100:.1f}%)")
    print(f"  By category:")
    for cat, s in sorted(by_cat.items()):
        total = s['pass'] + s['fail']
        print(f"    {cat:12} {s['pass']}/{total} ({s['pass']/total*100:.0f}%)")
    print(f"  Report: {out}")

if __name__ == '__main__':
    main()
