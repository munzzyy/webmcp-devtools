// lint.js
//
// Security linter for a WebMCP tool. A page registers tools that an AI agent
// can call, and the tool's own name, description, and input schema are fed to
// that agent as trusted instructions. That makes the metadata an injection
// surface ("tool poisoning"): a description that says "ignore previous
// instructions" is the WebMCP equivalent of a backdoor. This module reads a
// normalized tool and returns findings; panel.js renders them as text only.
//
// Contract (do not change shape without updating panel.js):
//   lintTool(tool) -> Array<{ id, severity, title, detail }>
//   severity is one of 'critical' | 'high' | 'medium' | 'low' | 'info'
//   tool is the output of core/normalizeTool.js:
//     { name, description, inputSchema (object), inputSchemaError, annotations, origin }
//
// Pure: no chrome.* and no DOM. Unit-tested with node --test.

const INJECTION_PATTERNS = [
  [/\bignore\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|context|rules?|messages?)/i,
    'high', 'Instruction-override text in a tool field',
    'Tells the agent to ignore previous instructions. A tool description is read as trusted context, so this is a prompt-injection payload (tool poisoning).'],
  [/\bdisregard\s+(?:all\s+|any\s+)?(?:the\s+|your\s+|previous\s+|prior\s+|system\s+)?(?:instructions?|prompts?|rules?|guidelines?)/i,
    'high', 'Instruction-override text in a tool field',
    'Tells the agent to disregard its instructions or guidelines.'],
  [/\boverride\s+(?:your|the|all|any|previous|system)\s+(?:instructions?|guidelines?|rules?|safety|system\s+prompt|restrictions?)/i,
    'high', 'Instruction-override text in a tool field',
    'Tries to override the agent\'s guidelines, safety, or system prompt.'],
  [/\bdo\s+not\s+(?:tell|inform|mention|alert|notify|warn|show)\s+(?:the\s+)?user/i,
    'high', 'Hide-from-user directive in a tool field',
    'Instructs the agent to conceal an action from the user.'],
  [/\b(?:reveal|print|repeat|output|disclose|leak|exfiltrate|send)\s+(?:your|the|its)\s+(?:system\s+prompt|initial\s+instructions|instructions|api\s?key|credentials|secrets?)/i,
    'critical', 'Secret/prompt-disclosure directive in a tool field',
    'Tries to get the agent to reveal its system prompt, credentials, or secrets.'],
  [/\byou\s+are\s+now\s+(?:a|an|in|the|no\s+longer)\b/i,
    'medium', 'Persona-override text in a tool field',
    'Attempts to redefine what the agent is, a common jailbreak opener.'],
  [/\bwithout\s+(?:telling|informing|asking|notifying|alerting)\s+(?:the\s+)?(?:user|them)\b/i,
    'high', 'Act-without-consent directive in a tool field',
    'Instructs the agent to act without informing or asking the user.'],
];

// Endpoints whose purpose is receiving out-of-band data.
const SINK = /(?:webhook\.site|requestbin\.\w+|pipedream\.net|hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|[0-9a-z-]+\.ngrok(?:-free)?\.(?:io|app|dev)|pastebin\.com|transfer\.sh|0x0\.st|\.oast\.(?:fun|live|pro|online|site)|burpcollaborator\.net|interact\.sh|dnslog\.cn)/i;

// Credential formats that should never appear in a tool description or schema.
const SECRET = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/;

// Parameter names that are dangerous when free-form (arbitrary payload passthrough).
const RISKY_PARAM = /^(?:command|cmd|code|script|shell|exec|sql|query|eval|path|filepath|file|url|uri|endpoint|host|redirect|callback|prompt|template|html|payload)$/i;

// Invisible / deceptive Unicode.
function scanUnicode(field, text) {
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xe0000 && cp <= 0xe007f) {
      out.push(finding('uni-tag', 'critical', `Invisible Unicode tag character in ${field}`,
        `U+${hex(cp)} is an invisible tag character, the standard way to smuggle hidden instructions into text the agent reads but a human does not.`));
    } else if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
      out.push(finding('uni-bidi', 'critical', `Bidirectional control character in ${field}`,
        `U+${hex(cp)} can make the rendered text differ from what is parsed (Trojan Source).`));
    } else if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff || cp === 0x00ad) {
      out.push(finding('uni-zw', 'high', `Zero-width / invisible character in ${field}`,
        `U+${hex(cp)} is invisible and is often used to hide or break up text so a reviewer misses it.`));
    }
  }
  return dedupeByTitle(out);
}

function hex(cp) {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

function finding(id, severity, title, detail) {
  return { id, severity, title, detail };
}

function dedupeByTitle(list) {
  const seen = new Set();
  const out = [];
  for (const f of list) {
    if (seen.has(f.title)) continue;
    seen.add(f.title);
    out.push(f);
  }
  return out;
}

export function lintTool(tool) {
  const t = tool && typeof tool === 'object' ? tool : {};
  const name = typeof t.name === 'string' ? t.name : '';
  const description = typeof t.description === 'string' ? t.description : '';
  const annotations = t.annotations && typeof t.annotations === 'object' ? t.annotations : {};
  const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {};
  const findings = [];

  // 1. Prompt injection in name or description.
  for (const [fieldName, value] of [['name', name], ['description', description]]) {
    for (const [rx, severity, title, detail] of INJECTION_PATTERNS) {
      if (rx.test(value)) {
        findings.push(finding('inject', severity, `${title} (${fieldName})`, detail));
      }
    }
  }

  // 2. Hidden Unicode in name or description.
  findings.push(...scanUnicode('name', name));
  findings.push(...scanUnicode('description', description));

  // 3. Known exfiltration endpoint referenced.
  const sinkHit = SINK.exec(description) || SINK.exec(JSON.stringify(schema));
  if (sinkHit) {
    findings.push(finding('sink', 'high', 'References a data-collection endpoint',
      `Mentions "${sinkHit[0]}", a paste/webhook/tunnel endpoint whose purpose is receiving data out-of-band.`));
  }

  // 4. Hardcoded secret in metadata.
  if (SECRET.test(description) || SECRET.test(JSON.stringify(schema))) {
    findings.push(finding('secret', 'high', 'Possible hardcoded credential in tool metadata',
      'A credential-shaped string appears in the tool description or schema. Anything shipped in page source is exposed.'));
  }

  // 5. Over-parameterization: free-form params that let the agent pass arbitrary payloads.
  for (const [propName, spec] of Object.entries(schemaProperties(schema))) {
    if (!RISKY_PARAM.test(propName)) continue;
    if (isFreeformString(spec)) {
      findings.push(finding('overparam', 'medium', `Unconstrained "${propName}" parameter`,
        `The "${propName}" parameter is a free-form string with no enum, format, or length limit. Names like this often carry executable or path-like payloads, so the agent can be steered into passing something dangerous.`));
    }
  }

  // 6. Inherently dangerous capability handed to an agent.
  const dangerText = /\b(?:arbitrary|any)\s+(?:shell\s+|system\s+)?(?:command|commands|code|script|sql|query)\b/i;
  const dangerName = /runshell|runcommand|run_command|execute(?:command|code|shell)|(?:^|_|-)(?:exec|eval|shell|system)(?:$|_|-)/i;
  if (dangerText.test(description) || dangerName.test(name)) {
    findings.push(finding('capability', 'high', 'Exposes arbitrary code or command execution',
      'This tool appears to run arbitrary commands, code, or queries. Exposed to an agent, any successful injection becomes remote code execution. Constrain it to specific, named operations.'));
  }

  // 7. Behavior/annotation mismatch: a read-shaped name that is not marked read-only.
  if (isReadShaped(name) && annotations.readOnlyHint !== true) {
    findings.push(finding('mismatch', 'low', 'Read-shaped name is not marked read-only',
      `"${name}" reads like a lookup but readOnlyHint is not set. If it does mutate state the name is misleading; if it does not, set readOnlyHint so agents can treat it safely.`));
  }

  // 8. Untrusted-content hint present: results may carry injection.
  if (annotations.untrustedContentHint === true) {
    findings.push(finding('untrusted', 'info', 'Tool returns untrusted content',
      'This tool is flagged as returning untrusted content. Whatever it returns can contain injection aimed at the agent, so treat its output as data, not instructions.'));
  }

  // 9. Malformed or missing schema / description hygiene.
  if (t.inputSchemaError) {
    findings.push(finding('schema', 'low', 'Input schema is malformed', String(t.inputSchemaError)));
  }
  if (!description.trim()) {
    findings.push(finding('nodesc', 'low', 'Tool has no description',
      'A tool with no description gives the agent nothing to reason about and cannot be reviewed.'));
  }

  return findings;
}

// A name is "read-shaped" if it starts with a lookup verb followed by a word
// boundary that also covers camelCase (getBalance) and separators (get_balance),
// but not a longer lowercase word (getting, reader).
const READ_VERBS = ['get', 'list', 'read', 'search', 'find', 'fetch', 'show', 'view', 'query'];

function isReadShaped(name) {
  const lower = name.toLowerCase();
  for (const v of READ_VERBS) {
    if (lower.startsWith(v)) {
      const rest = name.slice(v.length);
      if (rest === '' || /^[^a-z]/.test(rest)) return true;
    }
  }
  return false;
}

function schemaProperties(schema) {
  const props = schema && schema.properties;
  return props && typeof props === 'object' ? props : {};
}

function isFreeformString(spec) {
  if (!spec || typeof spec !== 'object') return false;
  const isString = spec.type === 'string' || (Array.isArray(spec.type) && spec.type.includes('string'));
  if (!isString) return false;
  const constrained = spec.enum || spec.const || spec.format || spec.pattern ||
    typeof spec.maxLength === 'number' || Array.isArray(spec.anyOf) || Array.isArray(spec.oneOf);
  return !constrained;
}
