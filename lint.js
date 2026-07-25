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
  [/\b(?:do\s+not|must\s+not|never)\s+(?:tell|inform|mention|alert|notify|warn|show)\s+(?:the\s+)?user/i,
    'high', 'Hide-from-user directive in a tool field',
    'Instructs the agent to conceal an action from the user.'],
  [/\bforget\s+(?:everything|all\b|your|the\s+(?:above|previous|prior))/i,
    'high', 'Instruction-override text in a tool field',
    'Tells the agent to forget its prior instructions or context, a reset-and-hijack payload.'],
  [/\b(?:system|assistant|developer)\s*:\s*(?:you\s+(?:are|have|now|can|must|will)|ignore|disregard|grant|now\s+you)/i,
    'high', 'Fake role header in a tool field',
    'Impersonates a system/assistant role prompt to inject instructions the agent may treat as higher-priority.'],
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
// The ngrok label is bounded to a real DNS-label length (1-63 chars) and its
// left edge is anchored with a lookbehind. An unbounded `[0-9a-z-]+` in front
// of a literal suffix backtracks quadratically, so a page could feed a
// multi-KB run of that class and freeze the linter for seconds -- the exact
// anti-analysis trick this tool exists to catch.
const SINK = /(?:webhook\.site|requestbin\.\w+|pipedream\.net|hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|(?<![0-9a-z-])[0-9a-z-]{1,63}\.ngrok(?:-free)?\.(?:io|app|dev)|pastebin\.com|transfer\.sh|0x0\.st|\.oast\.(?:fun|live|pro|online|site)|burpcollaborator\.net|interact\.sh|dnslog\.cn)/i;

// Credential formats that should never appear in a tool description or schema.
const SECRET = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/;

// Parameter names that are dangerous when free-form (arbitrary payload passthrough).
const RISKY_PARAM = /^(?:command|cmd|code|script|shell|exec|sql|query|eval|path|filepath|file|url|uri|endpoint|host|redirect|callback|prompt|template|html|payload)$/i;

// Invisible / deceptive Unicode.
function scanUnicode(field, text) {
  const out = [];
  let index = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    // A U+FEFF at the very start is a byte-order mark -- a benign (if
    // pointless) string lead-in, not a hidden separator. Only flag it mid-text.
    if (cp === 0xfeff && index === 0) {
      index += 1;
      continue;
    }
    if (cp >= 0xe0000 && cp <= 0xe007f) {
      out.push(finding('uni-tag', 'critical', `Invisible Unicode tag character in ${field}`,
        `U+${hex(cp)} is an invisible tag character, the standard way to smuggle hidden instructions into text the agent reads but a human does not.`));
    } else if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
      out.push(finding('uni-bidi', 'critical', `Bidirectional control character in ${field}`,
        `U+${hex(cp)} can make the rendered text differ from what is parsed (Trojan Source).`));
    } else if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || (cp >= 0x2061 && cp <= 0x2064) || cp === 0xfeff || cp === 0x00ad) {
      out.push(finding('uni-zw', 'high', `Zero-width / invisible character in ${field}`,
        `U+${hex(cp)} is invisible and is often used to hide or break up text so a reviewer misses it.`));
    }
    index += 1;
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

  // Cap what the pattern scans read. The whole point of this linter is to look
  // at hostile, page-controlled metadata, so a page can hand us a megabyte of
  // text purely to make the regex work expensive. 16 KB is far more than any
  // real tool field needs; anything past it is scanned truncated and the
  // truncation is reported as its own finding.
  const MAX_SCAN = 16384;
  const schemaJson = JSON.stringify(schema);
  const descScan = description.length > MAX_SCAN ? description.slice(0, MAX_SCAN) : description;
  const schemaScan = schemaJson.length > MAX_SCAN ? schemaJson.slice(0, MAX_SCAN) : schemaJson;

  // Name and description are the strings the agent actually reads, so injection
  // phrasing there lands directly in its context.
  for (const [fieldName, value] of [['name', name], ['description', descScan]]) {
    // NFKC first: it maps fullwidth/compatibility Unicode variants (e.g. the
    // fullwidth "ｉｇｎｏｒｅ" and an ideographic space) down to plain ASCII,
    // so a phrase spelled in look-alike Unicode reads the same as the plain
    // one. Then match a separator-folded copy too: attackers break naive
    // keyword regexes with markdown, underscores, or dashes ("ignore**
    // previous", "ignore-previous", "_ignore previous") while the phrase
    // stays readable to the agent. Fold only those glue characters and
    // whitespace -- keep sentence punctuation (.,;:) as a hard boundary so a
    // comma- or period-separated word list ("Flags: ignore, previous,
    // instructions") is not misread as a running phrase. Findings still
    // report the tool's original field value.
    const normalized = String(value).normalize('NFKC');
    const folded = normalized.replace(/[\s_*~`-]+/g, ' ');
    for (const [rx, severity, title, detail] of INJECTION_PATTERNS) {
      if (rx.test(normalized) || rx.test(folded)) {
        findings.push(finding('inject', severity, `${title} (${fieldName})`, detail));
      }
    }
  }

  // Zero-width and bidi characters survive copy-paste but never render, which is
  // what makes them the classic carrier for hidden instructions.
  findings.push(...scanUnicode('name', name));
  findings.push(...scanUnicode('description', description));

  const sinkHit = SINK.exec(descScan) || SINK.exec(schemaScan);
  if (sinkHit) {
    findings.push(finding('sink', 'high', 'References a data-collection endpoint',
      `Mentions "${sinkHit[0]}", a paste/webhook/tunnel endpoint whose purpose is receiving data out-of-band.`));
  }

  if (SECRET.test(descScan) || SECRET.test(schemaScan)) {
    findings.push(finding('secret', 'high', 'Possible hardcoded credential in tool metadata',
      'A credential-shaped string appears in the tool description or schema. Anything shipped in page source is exposed.'));
  }

  // Params only get flagged when a risky NAME meets a free-form spec - "url" as an
  // enum of three values is fine, "url" as an unbounded string is a payload channel.
  for (const [propName, spec] of Object.entries(schemaProperties(schema))) {
    if (!RISKY_PARAM.test(propName)) continue;
    if (isFreeformString(spec)) {
      findings.push(finding('overparam', 'medium', `Unconstrained "${propName}" parameter`,
        `The "${propName}" parameter is a free-form string with no enum, format, or length limit. Names like this often carry executable or path-like payloads, so the agent can be steered into passing something dangerous.`));
    }
  }

  const dangerText = /\b(?:arbitrary|any)\s+(?:shell\s+|system\s+)?(?:command|commands|code|script|scripts|sql|query|queries)\b/i;
  const dangerName = /runshell|runcommand|run_command|execute(?:command|code|shell)|shell_?exec|exec_?shell/i;
  // Split camelCase and snake/kebab case into words so systemExec and doEval
  // count the same as system_exec, without matching eval inside "evaluation".
  const dangerWord = /^(?:exec|eval|shell|system)$/i;
  // A lone "system" or "shell" word (getSystemInfo, shellSort) is only a naming
  // smell. It rises to the high capability finding when it sits right next to a
  // word that implies actually running something: systemExec, shellRun, doEval.
  const actionWord = /^(?:exec|eval|shell|system|run|execute|invoke|call|do|spawn|launch|command|cmd|code|script|query|sql|raw|arbitrary)$/i;
  const nameWords = name.split(/[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  let dangerPair = false;
  let loneDanger = false;
  for (let i = 0; i < nameWords.length; i += 1) {
    if (!dangerWord.test(nameWords[i])) continue;
    const neighbourIsAction =
      (i > 0 && actionWord.test(nameWords[i - 1])) ||
      (i + 1 < nameWords.length && actionWord.test(nameWords[i + 1]));
    if (neighbourIsAction) dangerPair = true;
    else loneDanger = true;
  }
  if (dangerText.test(descScan) || dangerName.test(name) || dangerPair) {
    findings.push(finding('capability', 'high', 'Exposes arbitrary code or command execution',
      'This tool appears to run arbitrary commands, code, or queries. Exposed to an agent, any successful injection becomes remote code execution. Constrain it to specific, named operations.'));
  } else if (loneDanger) {
    findings.push(finding('capability', 'low', 'Name hints at command or code execution',
      `"${name}" contains an execution-related word (exec, eval, shell, or system). On its own that is only a naming smell, but if this tool does run commands or code, constrain it to specific, named operations and describe it accurately.`));
  }

  if (isReadShaped(name) && annotations.readOnlyHint !== true) {
    findings.push(finding('mismatch', 'low', 'Read-shaped name is not marked read-only',
      `"${name}" reads like a lookup but readOnlyHint is not set. If it does mutate state the name is misleading; if it does not, set readOnlyHint so agents can treat it safely.`));
  }

  if (annotations.untrustedContentHint === true) {
    findings.push(finding('untrusted', 'info', 'Tool returns untrusted content',
      'This tool is flagged as returning untrusted content. Whatever it returns can contain injection aimed at the agent, so treat its output as data, not instructions.'));
  }

  if (t.inputSchemaError) {
    findings.push(finding('schema', 'low', 'Input schema is malformed', String(t.inputSchemaError)));
  }
  if (!description.trim()) {
    findings.push(finding('nodesc', 'low', 'Tool has no description',
      'A tool with no description gives the agent nothing to reason about and cannot be reviewed.'));
  }
  if (description.length > MAX_SCAN || schemaJson.length > MAX_SCAN) {
    findings.push(finding('truncated', 'low', 'Oversized tool metadata (scanned first 16 KB)',
      'The description or schema is larger than 16 KB, so only the first 16 KB was scanned for injection and exfiltration patterns. An oversized tool field is itself unusual for a legitimate tool.'));
  }

  return findings;
}

// A name is "read-shaped" if it starts with a lookup verb followed by a word
// boundary that also covers camelCase (getBalance) and separators (get_balance),
// but not a longer word in the same case (getting, reader, GETTING).
const READ_VERBS = ['get', 'list', 'read', 'search', 'find', 'fetch', 'show', 'view', 'query'];

function isReadShaped(name) {
  const lower = name.toLowerCase();
  // In an all-caps name the case flip is not a boundary: GETTING is one word,
  // GET_USER still splits on the underscore.
  const boundary = /[a-z]/.test(name) ? /^[^a-z]/ : /^[^a-zA-Z]/;
  for (const v of READ_VERBS) {
    if (lower.startsWith(v)) {
      const rest = name.slice(v.length);
      if (rest === '' || boundary.test(rest)) return true;
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
  // A schema with no `type` accepts any JSON value, strings included, so an
  // untyped risky param is just as free-form as an explicit string one. Only
  // bail when a composite (allOf/anyOf/oneOf) is carrying the real shape.
  const untyped = spec.type === undefined && !spec.allOf && !spec.anyOf && !spec.oneOf;
  const isString = spec.type === 'string' ||
    (Array.isArray(spec.type) && spec.type.includes('string')) || untyped;
  if (!isString) return false;
  const constrained = spec.enum || spec.const || spec.format || spec.pattern ||
    typeof spec.maxLength === 'number' || Array.isArray(spec.allOf) ||
    Array.isArray(spec.anyOf) || Array.isArray(spec.oneOf);
  return !constrained;
}
