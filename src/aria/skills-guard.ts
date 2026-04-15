// Skill security scanner — port of Hermes tools/skills_guard.py threat patterns.
// Runs over newly-created or patched SKILL.md content before it's visible to the agent.
// Verdict: 'safe' | 'caution' | 'dangerous'. Dangerous → block + rollback. Caution → warn + allow.

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Verdict = 'safe' | 'caution' | 'dangerous';
export type Category =
  | 'exfiltration'
  | 'injection'
  | 'destructive'
  | 'persistence'
  | 'network'
  | 'obfuscation'
  | 'execution'
  | 'traversal'
  | 'supply_chain'
  | 'privilege_escalation'
  | 'credential_exposure'
  | 'mining';

export interface ThreatPattern {
  id: string;
  severity: Severity;
  category: Category;
  reason: string;
  regex: RegExp;
}

// Port target: Hermes tools/skills_guard.py THREAT_PATTERNS (L82-450).
export const SKILL_THREAT_PATTERNS: ThreatPattern[] = [
  // ── Exfiltration ──
  {
    id: 'env_exfil_curl',
    severity: 'critical',
    category: 'exfiltration',
    reason: 'curl interpolates a secret env var (KEY/TOKEN/SECRET/PASSWORD/API)',
    regex: /curl[^\n]{0,200}\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  },
  {
    id: 'env_exfil_wget',
    severity: 'critical',
    category: 'exfiltration',
    reason: 'wget interpolates a secret env var',
    regex: /wget[^\n]{0,200}\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  },
  {
    id: 'env_exfil_fetch',
    severity: 'critical',
    category: 'exfiltration',
    reason: 'fetch() call with secret env var in URL/body',
    regex: /fetch\s*\([^\n]{0,200}\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|API)/i,
  },
  {
    id: 'env_exfil_requests',
    severity: 'critical',
    category: 'exfiltration',
    reason: 'Python requests call carrying secret variable',
    regex: /requests\.(?:get|post|put|patch)\s*\([^\n]{0,200}(?:KEY|TOKEN|SECRET|PASSWORD)/i,
  },
  {
    id: 'ssh_dir_access',
    severity: 'high',
    category: 'exfiltration',
    reason: 'References user SSH directory (~/.ssh)',
    regex: /(?:\$HOME|~)\/\.ssh\b/,
  },
  {
    id: 'aws_dir_access',
    severity: 'high',
    category: 'exfiltration',
    reason: 'References user AWS credentials directory (~/.aws)',
    regex: /(?:\$HOME|~)\/\.aws\b/,
  },
  {
    id: 'gpg_dir_access',
    severity: 'high',
    category: 'exfiltration',
    reason: 'References user GPG keyring (~/.gnupg)',
    regex: /(?:\$HOME|~)\/\.gnupg\b/,
  },
  {
    id: 'read_secrets_file',
    severity: 'critical',
    category: 'exfiltration',
    reason: 'Reads known secrets file (.env, credentials, .netrc, .pgpass, .npmrc, .pypirc)',
    regex: /\b(?:cat|less|more|head|tail|grep|awk|sed)\s+[^\n]*(?:\.env\b|credentials\b|\.netrc\b|\.pgpass\b|\.npmrc\b|\.pypirc\b)/i,
  },
  {
    id: 'dump_all_env',
    severity: 'high',
    category: 'exfiltration',
    reason: 'Dumps all environment variables (printenv or env|...)',
    regex: /\b(?:printenv\b|env\s*\|)/,
  },
  {
    id: 'python_getenv_secret',
    severity: 'critical',
    category: 'exfiltration',
    reason: 'Python reads secret via os.getenv/os.environ',
    regex: /os\.(?:getenv\s*\(|environ(?:\.get\s*\(|\s*\[))\s*['"][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*['"]/i,
  },
  {
    id: 'node_process_env',
    severity: 'high',
    category: 'exfiltration',
    reason: 'Node process.env[...] access (potential env dump)',
    regex: /process\.env\[/,
  },
  {
    id: 'dns_exfil',
    severity: 'critical',
    category: 'exfiltration',
    reason: 'DNS tool with variable interpolation (possible DNS exfiltration)',
    regex: /\b(?:dig|nslookup|host)\s+[^\n]*\$/,
  },
  {
    id: 'tmp_staging',
    severity: 'critical',
    category: 'exfiltration',
    reason: 'Writes /tmp staging file then exfiltrates via curl/wget/nc',
    regex: />\s*\/tmp\/[^\s]*\s*&&\s*(?:curl|wget|nc|python)/,
  },
  {
    id: 'md_image_exfil',
    severity: 'high',
    category: 'exfiltration',
    reason: 'Markdown image URL with variable interpolation (image-based exfil)',
    regex: /!\[[^\]]*\]\(https?:\/\/[^)]*\$\{?/,
  },

  // ── Injection ──
  {
    id: 'prompt_injection_ignore',
    severity: 'critical',
    category: 'injection',
    reason: 'Prompt injection: "ignore previous instructions"',
    regex: /ignore\s+(?:\w+\s+){0,3}(?:previous|all|above|prior)\s+instructions/i,
  },
  {
    id: 'role_hijack',
    severity: 'high',
    category: 'injection',
    reason: 'Attempts to override assistant role',
    regex: /\byou are (?:now|an?) [^\n.]{0,80}(?:different|new|unrestricted|jailbroken|dan\b|developer mode|god mode)/i,
  },
  {
    id: 'deception_hide',
    severity: 'critical',
    category: 'injection',
    reason: 'Instructs agent to hide information from user',
    regex: /do\s+not\s+(?:\w+\s+){0,3}tell\s+(?:\w+\s+){0,3}the\s+user/i,
  },
  {
    id: 'sys_prompt_override',
    severity: 'critical',
    category: 'injection',
    reason: 'Attempts to override the system prompt',
    regex: /system\s+prompt\s+override/i,
  },
  {
    id: 'disregard_rules',
    severity: 'critical',
    category: 'injection',
    reason: 'Instructs agent to disregard its rules/guidelines',
    regex: /disregard\s+(?:\w+\s+){0,3}(?:your|all|any)\s+(?:\w+\s+){0,3}(?:instructions|rules|guidelines)/i,
  },
  {
    id: 'leak_system_prompt',
    severity: 'high',
    category: 'injection',
    reason: 'Attempts to extract the system/initial prompt',
    regex: /output\s+(?:\w+\s+){0,3}(?:system|initial)\s+prompt/i,
  },
  {
    id: 'bypass_restrictions',
    severity: 'critical',
    category: 'injection',
    reason: 'Instructs agent to act without restrictions',
    regex: /act\s+as\s+(?:if|though)\s+(?:\w+\s+){0,3}you\s+(?:\w+\s+){0,3}(?:have\s+no|don'?t\s+have)\s+(?:\w+\s+){0,3}(?:restrictions|limits|rules)/i,
  },
  {
    id: 'html_comment_injection',
    severity: 'high',
    category: 'injection',
    reason: 'Hidden instructions embedded in HTML comments',
    regex: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i,
  },

  // ── Destructive ──
  {
    id: 'rm_rf_root',
    severity: 'critical',
    category: 'destructive',
    reason: 'Recursive-force delete of root / home / system path',
    regex: /\brm\s+[^\n]*-[a-z]*[rf][a-z]*[rf][a-z]*\s+(?:\/|~|\$HOME|--no-preserve-root)/i,
  },
  {
    id: 'system_overwrite',
    severity: 'critical',
    category: 'destructive',
    reason: 'Overwrites system configuration file (> /etc/...)',
    regex: />\s*\/etc\//,
  },
  {
    id: 'format_filesystem',
    severity: 'critical',
    category: 'destructive',
    reason: 'Formats a filesystem (mkfs)',
    regex: /\bmkfs(?:\.\w+)?\b/,
  },
  {
    id: 'disk_overwrite',
    severity: 'critical',
    category: 'destructive',
    reason: 'Raw disk write (dd of=/dev/...)',
    regex: /\bdd\s+[^\n]*if=[^\n]*of=\/dev\//,
  },
  {
    id: 'python_rmtree',
    severity: 'high',
    category: 'destructive',
    reason: 'Python shutil.rmtree on absolute/root path',
    regex: /shutil\.rmtree\s*\(\s*["'\/]/,
  },
  {
    id: 'chmod_777',
    severity: 'medium',
    category: 'destructive',
    reason: 'Sets world-writable permissions (chmod 777)',
    regex: /chmod\s+777\b/,
  },

  // ── Persistence ──
  {
    id: 'shell_rc_mod',
    severity: 'medium',
    category: 'persistence',
    reason: 'Writes to shell rc file (.bashrc/.zshrc/.profile/...)',
    regex: /(?:>>?|tee(?:\s+-a)?)\s+[^\n|]*~?\/?\.(?:bashrc|zshrc|profile|bash_profile|zprofile|zlogin|bash_login)/i,
  },
  {
    id: 'persistence_cron',
    severity: 'medium',
    category: 'persistence',
    reason: 'Modifies cron jobs (crontab)',
    regex: /\bcrontab\b/,
  },
  {
    id: 'ssh_backdoor',
    severity: 'critical',
    category: 'persistence',
    reason: 'Modifies SSH authorized_keys (backdoor install)',
    regex: /authorized_keys\b/,
  },
  {
    id: 'macos_launchd',
    severity: 'medium',
    category: 'persistence',
    reason: 'macOS launch agent/daemon persistence',
    regex: /launchctl\s+load|LaunchAgents|LaunchDaemons/,
  },
  {
    id: 'sudoers_mod',
    severity: 'critical',
    category: 'persistence',
    reason: 'Modifies sudoers (privilege escalation persistence)',
    regex: /\/etc\/sudoers|\bvisudo\b/,
  },
  {
    id: 'agent_config_mod',
    severity: 'critical',
    category: 'persistence',
    reason: 'References agent config files (CLAUDE.md/AGENTS.md/.cursorrules) — cross-session malicious persistence',
    regex: /(?:\bAGENTS\.md\b|\bCLAUDE\.md\b|\.cursorrules\b|\.clinerules\b)/,
  },

  // ── Network ──
  {
    id: 'reverse_shell',
    severity: 'critical',
    category: 'network',
    reason: 'Opens reverse shell (nc -e, mkfifo pipe, bash /dev/tcp)',
    regex: /(?:bash\s+-i\s*>(?:&|\s*\/dev\/tcp)|\bnc\s+[^\n]{0,80}-e\s*(?:bash|sh|\/bin\/[a-z]+)|mkfifo\s+[^\n]*\s*\|\s*(?:bash|sh)\b)/i,
  },
  {
    id: 'bash_reverse_shell',
    severity: 'critical',
    category: 'network',
    reason: 'Bash interactive reverse shell via /dev/tcp',
    regex: /\/bin\/(?:ba)?sh\s+-i\s+[^\n]*>\/dev\/tcp\//,
  },
  {
    id: 'python_socket_oneliner',
    severity: 'critical',
    category: 'network',
    reason: 'Python one-liner socket connection (likely reverse shell)',
    regex: /python[23]?\s+-c\s+["']import\s+socket/,
  },
  {
    id: 'tunnel_service',
    severity: 'high',
    category: 'network',
    reason: 'Uses tunneling service for external access (ngrok/localtunnel/serveo/cloudflared)',
    regex: /\b(?:ngrok|localtunnel|serveo|cloudflared)\b/,
  },
  {
    id: 'exfil_service',
    severity: 'high',
    category: 'network',
    reason: 'References known data-exfil/webhook test service',
    regex: /\b(?:webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com)\b/,
  },

  // ── Obfuscation ──
  {
    id: 'base64_decode_pipe',
    severity: 'high',
    category: 'obfuscation',
    reason: 'base64 decode piped to execution',
    regex: /base64\s+(?:-d|--decode)\s*\|/,
  },
  {
    id: 'eval_string',
    severity: 'high',
    category: 'obfuscation',
    reason: 'eval() with string argument',
    regex: /\beval\s*\(\s*["']/,
  },
  {
    id: 'exec_string',
    severity: 'high',
    category: 'obfuscation',
    reason: 'exec() with string argument',
    regex: /\bexec\s*\(\s*["']/,
  },
  {
    id: 'echo_pipe_exec',
    severity: 'critical',
    category: 'obfuscation',
    reason: 'echo piped to interpreter for execution',
    regex: /echo\s+[^\n]*\|\s*(?:bash|sh|python[23]?|perl|ruby|node)\b/,
  },
  {
    id: 'chr_building',
    severity: 'high',
    category: 'obfuscation',
    reason: 'Obfuscated payload built from chr() calls',
    regex: /chr\s*\(\s*\d+\s*\)\s*\+\s*chr\s*\(\s*\d+/,
  },

  // ── Supply chain ──
  {
    id: 'curl_pipe_shell',
    severity: 'critical',
    category: 'supply_chain',
    reason: 'curl piped to shell (download-and-execute)',
    regex: /curl[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:bash|sh|zsh|ksh)\b/i,
  },
  {
    id: 'wget_pipe_shell',
    severity: 'critical',
    category: 'supply_chain',
    reason: 'wget piped to shell (download-and-execute)',
    regex: /wget[^\n|]{0,200}-O\s*-\s*\|\s*(?:sudo\s+)?(?:bash|sh)\b/i,
  },
  {
    id: 'curl_pipe_python',
    severity: 'critical',
    category: 'supply_chain',
    reason: 'curl piped to Python/Node/Ruby/Perl interpreter',
    regex: /curl[^\n|]{0,200}\|\s*(?:python[23]?|node|ruby|perl)\b/i,
  },

  // ── Privilege escalation ──
  {
    id: 'nopasswd_sudo',
    severity: 'critical',
    category: 'privilege_escalation',
    reason: 'NOPASSWD sudoers entry (passwordless escalation)',
    regex: /NOPASSWD/,
  },
  {
    id: 'setuid_setgid',
    severity: 'critical',
    category: 'privilege_escalation',
    reason: 'Sets setuid/setgid bit (escalation mechanism)',
    regex: /\bsetuid\b|\bsetgid\b|cap_setuid/,
  },
  {
    id: 'suid_bit',
    severity: 'critical',
    category: 'privilege_escalation',
    reason: 'chmod sets SUID/SGID bit on a file',
    regex: /chmod\s+[ugoa]*\+s\b/,
  },

  // ── Credential exposure ──
  {
    id: 'embedded_private_key',
    severity: 'critical',
    category: 'credential_exposure',
    reason: 'Embedded private key block',
    regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|DSA\s+)?PRIVATE\s+KEY-----/,
  },
  {
    id: 'github_token_leaked',
    severity: 'critical',
    category: 'credential_exposure',
    reason: 'GitHub personal access token present',
    regex: /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{80,}\b/,
  },
  {
    id: 'openai_key_leaked',
    severity: 'critical',
    category: 'credential_exposure',
    reason: 'Possible OpenAI API key present',
    regex: /\bsk-[A-Za-z0-9]{20,}\b/,
  },
  {
    id: 'anthropic_key_leaked',
    severity: 'critical',
    category: 'credential_exposure',
    reason: 'Possible Anthropic API key present',
    regex: /\bsk-ant-[A-Za-z0-9_-]{90,}\b/,
  },

  // ── Mining ──
  {
    id: 'crypto_mining',
    severity: 'critical',
    category: 'mining',
    reason: 'Cryptocurrency mining reference',
    regex: /\b(?:xmrig|stratum\+tcp|monero|coinhive|cryptonight)\b/i,
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
