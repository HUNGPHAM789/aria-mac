# ARIA on Mac M4 — Installation Guide

## Prerequisites
1. Install Homebrew: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
2. Install Node.js 20+: `brew install node`
3. Install Ollama: `brew install ollama` (or download from ollama.com)
4. Install ripgrep (for Grep tool): `brew install ripgrep`

## Pull Gemma 4 26B
```bash
ollama pull gemma4:27b
```
(~16GB download — grab a coffee)

## Optional: Pull embedding model (if no Gemini key)
```bash
ollama pull nomic-embed-text
```

## Clone & Install
```bash
git clone https://github.com/HUNGPHAM789/aria-mac.git
cd aria-mac
npm install
```

## Configure
```bash
cp .env.example .env.local
nano .env.local
# Fill in: TELEGRAM_BOT_TOKEN, ARIA_ALLOWED_TELEGRAM_ID
# Optionally add GEMINI_API_KEY for better memory embeddings
```

## Start Ollama (keep running in background)
```bash
ollama serve
```

## Run ARIA
```bash
npm run aria
```

## Verify
1. Send a message to your Telegram bot
2. Check terminal for `[ARIA] Telegram bot online ✓`
3. ARIA should respond within a few seconds

## Troubleshooting
- **"Connection refused"**: Make sure `ollama serve` is running
- **Slow responses**: Gemma 4 26B needs ~16GB RAM. Close heavy apps.
- **No embeddings**: Either set `GEMINI_API_KEY` or run `ollama pull nomic-embed-text`
- **Telegram timeout**: Check your `TELEGRAM_BOT_TOKEN` is correct
