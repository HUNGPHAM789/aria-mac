// Skill security scanner — port of Hermes tools/skills_guard.py top threat patterns.
// Runs over newly-created or patched SKILL.md content before it's visible to the agent.
// Verdict: 'safe' | 'caution' | 'dangerous'. Dangerous → block + rollback. Caution → warn + allow.
// Scope: top 5 patterns from the Hermes set of ~70; expand as we see real authored skills.

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Verdict = 'safe' | 'caution' | 'dangerous';

export interface ThreatPattern {
  id: string;
  severity: Severity;
  reason: string;
  regex: RegExp;
}

// Patterns source: hermes-agent/tools/skills_guard.py L48-110 (top 5).
export const SKILL_THREAT_PATTERNS: ThreatPattern[] = [
  {
    id: 'env_exfil_curl',
    severity: 'critical',
    reason: 'Exfiltrates env-var secrets via curl HTTP request',
    regex: /curl[^\n]{0,200}\$(?:[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*)/i,
  },
  {
    id: 'read_secrets_file',
    severity: 'critical',
    reason: 'Reads local secret file (~/.env, ~/.netrc, ~/.pgpass, ~/.aws/credentials, ~/.ssh/id_*)',
    regex: /\b(?:cat|less|more|head|tail|grep|awk|sed)\s+[^\n]*(?:~\/\.(?:env|netrc|pgpass|aws\/credentials|ssh\/id_[a-z0-9_]+))/i,
  },
  {
    id: 'python_getenv_secret',
    severity: 'critical',
    reason: 'Python code reads secret env vars (os.getenv / os.environ with KEY/TOKEN/SECRET names)',
    regex: /os\.(?:getenv|environ(?:\.get)?)\s*\(\s*['"][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*['"]/i,
  },
  {
    id: 'role_hijack',
    severity: 'high',
    reason: 'Prompt-injection phrase attempting to override assistant role',
    regex: /\byou are (?:now|an?) [^\n.]{0,80}(?:different|new|unrestricted|jailbroken|dan\b|developer mode|god mode)/i,
  },
  {
    id: 'shell_rc_mod',
    severity: 'medium',
    reason: 'Modifies shell rc file for persistence (.bashrc / .zshrc / .profile / .bash_profile)',
    regex: /(?:>>?|tee(?:\s+-a)?)\s+[^\n|]*~?\/?\.(?:bashrc|zshrc|profile|bash_profile|zprofile)/i,
  },
  {
    id: 'curl_pipe_shell',
    severity: 'critical',
    reason: 'Executes unreviewed remote script (curl/wget piped to bash or sh)',
    regex: /(?:curl|wget)[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:bash|sh|zsh|ksh|python[23]?|node|ruby|perl)\b/i,
  },
  {
    id: 'rm_rf_root',
    severity: 'critical',
    reason: 'Destructive recursive-force delete of root / home / system path',
    regex: /\brm\s+[^\n]*-[a-z]*[rf][a-z]*[rf][a-z]*\s+(?:\/|~|\$HOME|--no-preserve-root)/i,
  },
  {
    id: 'reverse_shell',
    severity: 'critical',
    reason: 'Opens reverse shell to attacker-controlled host (bash /dev/tcp, nc -e, mkfifo pipe)',
    regex: /(?:bash\s+-i\s*>(?:&|\s*\/dev\/tcp)|nc\s+[^\n]{0,80}-e\s*(?:bash|sh|\/bin\/[a-z]+)|mkfifo\s+[^\n]*\s*\|\s*(?:bash|sh)\b)/i,
  },
];

export interface ScanHit {
  pattern: ThreatPattern;
  match: string;
  lineNumber: number;
}

export interface ScanResult {
  verdict: Verdict;
  hits: ScanHit[];
  summary: string;
}

export function scanSkillContent(content: string): ScanResult {
  const hits: ScanHit[] = [];
  const lines = content.split('\n');

  for (const pattern of SKILL_THREAT_PATTERNS) {
    // Run against full content for multi-line matches, then locate line for reporting.
    const match = pattern.regex.exec(content);
    if (!match) continue;
    let lineNumber = 1;
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineEnd = offset + lines[i].length + 1;
      if (match.index < lineEnd) { lineNumber = i + 1; break; }
      offset = lineEnd;
    }
    hits.push({ pattern, match: match[0].slice(0, 200), lineNumber });
  }

  let verdict: Verdict = 'safe';
  for (const hit of hits) {
    if (hit.pattern.severity === 'critical' || hit.pattern.severity === 'high') {
      verdict = 'dangerous';
      break;
    }
    if (hit.pattern.severity === 'medium' && verdict === 'safe') {
      verdict = 'caution';
    }
  }

  const summary =
    hits.length === 0
      ? 'clean'
      : hits
          .map(h => `L${h.lineNumber} ${h.pattern.id} (${h.pattern.severity}): ${h.pattern.reason}`)
          .join('; ');

  return { verdict, hits, summary };
}
