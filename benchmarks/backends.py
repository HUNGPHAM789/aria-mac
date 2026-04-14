"""
Backend adapters for benchmark suites.

Two frameworks currently supported:
  - aria   : POST to http://127.0.0.1:3100/api/dashboard/send (ARIA)
  - hermes : subprocess `hermes chat -q ... -Q --yolo` (Hermes Agent)

Both expose the same shape:
    call_backend(prompt, timeout=...) -> {
        "reply": str,
        "elapsed": str,           # seconds as string (for legacy compat)
        "taskType": str,          # "?" if the backend doesn't classify
        "corr": str,              # "" or session id
        "error": str,             # "" if ok, else message
    }

To use in a benchmark:
    from backends import get_backend
    call = get_backend(os.environ.get("BACKEND", "aria"))
    result = call(prompt, timeout=180)

Set BACKEND=hermes to route through Hermes.
"""
import json
import os
import re
import subprocess
import time
import urllib.request


ARIA_URL = "http://127.0.0.1:3100/api/dashboard/send"


def call_aria(prompt: str, timeout: int = 180) -> dict:
    """POST to ARIA's dashboard endpoint."""
    try:
        req = urllib.request.Request(
            ARIA_URL,
            data=json.dumps({"message": prompt}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
        return {
            "reply": data.get("reply", ""),
            "elapsed": str(data.get("elapsed", "?")),
            "taskType": data.get("taskType", "?"),
            "corr": data.get("corr", ""),
            "error": "",
        }
    except Exception as e:
        return {"reply": "", "elapsed": "?", "taskType": "?", "corr": "", "error": f"{type(e).__name__}: {e}"}


# Matches the lines that make up Hermes's banner box in -Q mode
_HERMES_BANNER_LINE = re.compile(r"^[\s]*[│╭╰╯─╮]")
_HERMES_SESSION_LINE = re.compile(r"^\s*session_id:\s*(\S+)\s*$")


def _parse_hermes_output(stdout: str) -> tuple[str, str]:
    """Return (reply_text, session_id) from hermes -Q stdout."""
    reply_lines: list[str] = []
    session_id = ""
    for line in stdout.splitlines():
        m = _HERMES_SESSION_LINE.match(line)
        if m:
            session_id = m.group(1)
            continue
        if _HERMES_BANNER_LINE.match(line):
            continue
        stripped = line.rstrip()
        if stripped:
            reply_lines.append(stripped)
    return ("\n".join(reply_lines).strip(), session_id)


def call_hermes(prompt: str, timeout: int = 300) -> dict:
    """Invoke hermes chat in quiet single-query mode."""
    start = time.time()
    try:
        proc = subprocess.run(
            [
                "hermes", "chat",
                "-q", prompt,
                "-Q",
                "--max-turns", "15",
                "--yolo",
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {
            "reply": "", "elapsed": f"{time.time() - start:.1f}",
            "taskType": "?", "corr": "", "error": "timeout",
        }
    except Exception as e:
        return {
            "reply": "", "elapsed": f"{time.time() - start:.1f}",
            "taskType": "?", "corr": "", "error": f"{type(e).__name__}: {e}",
        }

    elapsed = f"{time.time() - start:.1f}"
    reply, session_id = _parse_hermes_output(proc.stdout or "")
    if proc.returncode != 0 and not reply:
        err_tail = (proc.stderr or "").strip().splitlines()[-3:]
        return {
            "reply": "", "elapsed": elapsed, "taskType": "?", "corr": session_id,
            "error": f"exit={proc.returncode}: {' | '.join(err_tail)[:300]}",
        }
    return {
        "reply": reply,
        "elapsed": elapsed,
        "taskType": "?",  # Hermes doesn't classify like ARIA
        "corr": session_id,
        "error": "",
    }


BACKENDS = {"aria": call_aria, "hermes": call_hermes}


def get_backend(name: str):
    name = (name or "aria").lower()
    if name not in BACKENDS:
        raise ValueError(f"Unknown backend {name!r}. Choose from: {list(BACKENDS)}")
    return BACKENDS[name]
