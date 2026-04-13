# ARIA — Mac M4 Edition

**Adaptive Reasoning & Intelligence Assistant** — a personal AI that runs locally on Mac M4 via Ollama + Gemma 4 26B.

## Architecture

```
Telegram ←→ Telegraf Bot ←→ Ollama Agentic Loop ←→ Gemma 4 26B
                ↕                    ↕
            SQLite DB          Tool Executor
          (sessions,         (Bash, Read, Write,
           memory,            Edit, Glob, Grep,
           agents)            WebFetch, WebSearch)
```

## Features

- **Local AI**: Runs entirely on your Mac M4 — no cloud API needed for inference
- **Agentic tool use**: Full tool-calling loop with 9 built-in tools
- **Background agents**: Spawn long-running tasks (coder, researcher, reviewer)
- **Semantic memory**: Indexes your Claude memory files with vector search (Gemini or Ollama embeddings)
- **Cron scheduler**: Automated tasks with 5-field cron expressions
- **Telegram interface**: Real-time streaming responses with tool ribbons
- **HTTP API**: Mission Control integration on port 3100
- **Crash recovery**: Supervisor with crash loop protection and PID lockfile

## Quick Start

See [INSTALL.md](INSTALL.md) for full setup instructions.

```bash
ollama serve &
npm run aria
```

## Stack

- **Runtime**: Node.js + TypeScript (tsx)
- **AI**: Ollama REST API → Gemma 4 26B
- **Embeddings**: Gemini API (primary) or Ollama nomic-embed-text (fallback)
- **Database**: SQLite + sqlite-vec (vector search)
- **Bot**: Telegraf (Telegram Bot API)
- **Search**: Tavily API (optional)

## Key Differences from Windows Version

| Feature | Windows (Claude SDK) | Mac (Ollama) |
|---------|---------------------|--------------|
| Inference | Claude Agent SDK | Ollama REST API |
| Model | Claude Sonnet/Opus | Gemma 4 26B |
| Tools | SDK-native | Hand-rolled executor |
| MCP | SDK MCP servers | Direct function tools |
| Process mgmt | PowerShell/taskkill | lsof/kill |
| Embeddings | Gemini only | Gemini + Ollama fallback |
