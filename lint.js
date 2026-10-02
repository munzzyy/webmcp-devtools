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
//     { name, title, description, inputSchema (object), inputSchemaError, annotations, origin, degraded }
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

// Phrasing that reads as "this tool hands back content from outside the
// page" -- a fetched page, scraped text, another user's content -- which is
// exactly the case webmcp-lint's WML-002 flags when untrustedContentHint is
// not set. Mirrors that rule's keyword list so a manifest gets the same
// verdict here as from the CLI.
const UNTRUSTED_CONTENT_TEXT = /\b(?:returns?\s+(?:raw\s+)?html|user[\s-]generated\s+content|user\s+content|third[\s-]party\s+content|scrapes?|crawls?|fetch(?:es|ing|ed)?\s+(?:a\s+|the\s+)?(?:web\s?page|page|url|website|site|content)|reads?\s+(?:a\s+|the\s+)?(?:web\s?page|page|website|url)|retrieves?\s+(?:a\s+|the\s+)?(?:web\s?page|page|url|website|content)|downloads?\s+(?:a\s+|the\s+)?(?:file|page|content|url)|parses?\s+html|external\s+(?:content|data|website|page)|search(?:es)?\s+the\s+web|queries?\s+(?:a\s+|the\s+)?(?:web|internet|search\s+engine))\b/i;

// Cyrillic and Greek letters that render like a Latin one. Folding them lets
// "ign\u043ere" (with a Cyrillic o) match the injection patterns, and a word
// that mixes them into Latin letters is flagged on its own. Deliberately
// small: only letters a reader cannot tell apart from the Latin one.
const CONFUSABLES = new Map([
  ['\u0430', 'a'], ['\u0435', 'e'], ['\u043e', 'o'], ['\u0440', 'p'], ['\u0441', 'c'], ['\u0443', 'y'],
  ['\u0445', 'x'], ['\u0455', 's'], ['\u0456', 'i'], ['\u0458', 'j'], ['\u04bb', 'h'], ['\u04cf', 'l'],
  ['\u0501', 'd'], ['\u051b', 'q'], ['\u051d', 'w'],
  ['\u0410', 'A'], ['\u0412', 'B'], ['\u0415', 'E'], ['\u041a', 'K'], ['\u041c', 'M'], ['\u041d', 'H'],
  ['\u041e', 'O'], ['\u0420', 'P'], ['\u0421', 'C'], ['\u0422', 'T'], ['\u0425', 'X'], ['\u0405', 'S'],
  ['\u0406', 'I'], ['\u0408', 'J'], ['\u04ae', 'Y'], ['\u04c0', 'I'], ['\u051a', 'Q'], ['\u051c', 'W'],
  ['\u03b1', 'a'], ['\u03b9', 'i'], ['\u03ba', 'k'], ['\u03bd', 'v'], ['\u03bf', 'o'], ['\u03c1', 'p'],
  ['\u03c5', 'u'], ['\u03c7', 'x'],
  ['\u0391', 'A'], ['\u0392', 'B'], ['\u0395', 'E'], ['\u0396', 'Z'], ['\u0397', 'H'], ['\u0399', 'I'],
  ['\u039a', 'K'], ['\u039c', 'M'], ['\u039d', 'N'], ['\u039f', 'O'], ['\u03a1', 'P'], ['\u03a4', 'T'],
  ['\u03a5', 'Y'], ['\u03a7', 'X'],
]);
const GREEK_OR_CYRILLIC = /[\u0370-\u03ff\u0400-\u052f]/;
const LATIN_LETTER = /\p{Script=Latin}/u;
const WORD = /[\p{L}\p{M}]+/gu;

function foldConfusables(text) {
  if (!GREEK_OR_CYRILLIC.test(text)) return text;
  let out = '';
  for (const ch of text) out += CONFUSABLES.get(ch) ?? ch;
  return out;
}

function mixedScriptWord(text) {
  if (!GREEK_OR_CYRILLIC.test(text)) return null;
  for (const match of text.matchAll(WORD)) {
    let latin = false;
    let lookalike = null;
    for (const ch of match[0]) {
      if (CONFUSABLES.has(ch)) lookalike = lookalike || ch;
      else if (LATIN_LETTER.test(ch)) latin = true;
    }
    if (latin && lookalike) return { word: match[0], lookalike };
  }
  return null;
}

// NFKC first: it maps fullwidth/compatibility Unicode variants (e.g. the
// fullwidth "ｉｇｎｏｒｅ" and an ideographic space) down to plain ASCII, so a
// phrase spelled in look-alike Unicode reads the same as the plain one. Then
// the Cyrillic/Greek look-alike fold, then a separator-folded copy of each:
// attackers break naive keyword regexes with markdown, underscores, or dashes
// ("ignore** previous", "ignore-previous", "_ignore previous") while the
// phrase stays readable to the agent. Only those glue characters and
// whitespace fold. Sentence punctuation (.,;:) stays a hard boundary so a
// comma- or period-separated word list ("Flags: ignore, previous,
// instructions") is not misread as a running phrase.
function injectionHits(text) {
  const normalized = String(text).normalize('NFKC');
  const variants = [normalized];
  const folded = foldConfusables(normalized);
  if (folded !== normalized) variants.push(folded);
  for (const v of [...variants]) variants.push(v.replace(/[\s_*~`-]+/g, ' '));
  return INJECTION_PATTERNS.filter(([rx]) => variants.some((v) => rx.test(v)));
}

// Text the endpoint and credential patterns run on. NFKC turns "webhook.site"
// spelled in fullwidth letters back into the plain host the agent would read.
function patternText(text) {
  return foldConfusables(String(text).normalize('NFKC'));
}

// Characters that render as nothing. U+3164, U+115F, U+1160 and U+FFA0 are
// Hangul fillers, U+180E the old Mongolian vowel separator, and U+034F the
// combining grapheme joiner; outside the scripts that use them they only
// hide or break up text.
const INVISIBLE = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff, 0x00ad,
  0x3164, 0x115f, 0x1160, 0xffa0, 0x180e, 0x034f]);
// Letters only: U+061C itself counts as Arabic script, so the mark alone
// must not satisfy the check.
const RTL_LETTER = /[\p{L}&&[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}]]/v;
const EMOJI_BASE = /\p{Extended_Pictographic}/u;
const IDEOGRAPH = /\p{Ideographic}/u;

function isVariationSelector(cp) {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

// A variation selector picks the glyph of the character right before it: an
// emoji (U+2764 U+FE0F is the red heart), a keycap digit, or a CJK
// ideograph (U+E0100 and up). One anywhere else, or a run of them, is the
// carrier for text hidden as variation-selector bytes.
function variationSelectorAllowed(cps, i) {
  const cp = cps[i];
  const prev = i > 0 ? cps[i - 1] : -1;
  if (prev < 0 || isVariationSelector(prev)) return false;
  const prevCh = String.fromCodePoint(prev);
  if (cp >= 0xe0100) return IDEOGRAPH.test(prevCh);
  if (EMOJI_BASE.test(prevCh) || IDEOGRAPH.test(prevCh)) return true;
  return (cp === 0xfe0f || cp === 0xfe0e) && /^[0-9#*]$/.test(prevCh) && cps[i + 1] === 0x20e3;
}

function isControl(cp) {
  return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f);
}

// Invisible / deceptive Unicode. `path` narrows the finding to an exact spot
// inside a larger field (e.g. a schema property description); the title keeps
// the coarse field name so repeats of one payload dedupe to a single finding.
function scanUnicode(field, text, path) {
  const at = path ? `At ${path}: ` : '';
  const out = [];
  const cps = Array.from(text, (ch) => ch.codePointAt(0));
  let hasRtl = null;
  for (let i = 0; i < cps.length; i += 1) {
    const cp = cps[i];
    // A U+FEFF at the very start is a byte-order mark -- a benign (if
    // pointless) string lead-in, not a hidden separator. Only flag it mid-text.
    if (cp === 0xfeff && i === 0) continue;
    if (cp >= 0xe0000 && cp <= 0xe007f) {
      out.push(finding('uni-tag', 'critical', `Invisible Unicode tag character in ${field}`,
        `${at}U+${hex(cp)} is an invisible tag character, the standard way to smuggle hidden instructions into text the agent reads but a human does not.`));
    } else if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
      out.push(finding('uni-bidi', 'critical', `Bidirectional control character in ${field}`,
        `${at}U+${hex(cp)} can make the rendered text differ from what is parsed (Trojan Source).`));
    } else if (INVISIBLE.has(cp)) {
      out.push(finding('uni-zw', 'high', `Zero-width / invisible character in ${field}`,
        `${at}U+${hex(cp)} is invisible and is often used to hide or break up text so a reviewer misses it.`));
    } else if (cp === 0x200e || cp === 0x200f || cp === 0x061c) {
      if (hasRtl === null) hasRtl = RTL_LETTER.test(text);
      if (!hasRtl) {
        out.push(finding('uni-zw', 'high', `Directional mark with no right-to-left text in ${field}`,
          `${at}U+${hex(cp)} is an invisible direction mark, and this text has no right-to-left script for it to help with. Here it only hides or breaks up text.`));
      }
    } else if (isVariationSelector(cp)) {
      if (!variationSelectorAllowed(cps, i)) {
        out.push(finding('uni-vs', 'high', `Stray variation selector in ${field}`,
          `${at}U+${hex(cp)} is an invisible variation selector that is not styling an emoji or ideograph. Runs of them can carry hidden text that a reviewer never sees.`));
      }
    } else if (isControl(cp)) {
      out.push(finding('uni-control', 'high', `Control character in ${field}`,
        `${at}U+${hex(cp)} is a control character. It has no place in tool text, and some of them (ESC, for one) can drive the terminal that displays it.`));
    }
  }
  const mixed = mixedScriptWord(text);
  if (mixed) {
    const shown = mixed.word.length > 40 ? `${mixed.word.slice(0, 37)}...` : mixed.word;
    out.push(finding('uni-confusable', 'medium', `Mixed-script look-alike word in ${field}`,
      `${at}"${shown}" mixes Latin letters with a Cyrillic or Greek look-alike (U+${hex(mixed.lookalike.codePointAt(0))}). It reads the same to a person and to the agent, but slips past keyword filters.`));
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

// JSON.stringify with no guard is a page-triggerable crash: a schema with a
// self-reference throws TypeError, a BigInt value throws too, and both survive
// the structured-clone trip from the page intact. If lintTool throws, the
// panel's fallback used to be the only finding the user saw -- so one hostile
// key silently erased every real finding. Serialize defensively instead, and
// treat "cannot be serialized" as a signal in its own right.
function safeSchemaJson(schema) {
  try {
    return { json: JSON.stringify(schema), unserializable: false, reason: null };
  } catch (err) {
    const reason = err && err.message ? String(err.message) : String(err);
    return { json: serializeLossy(schema, [], 0), unserializable: true, reason };
  }
}

const MAX_SERIALIZE_DEPTH = 32;

function serializeLossy(value, ancestors, depth) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify(`${value}n`);
  if (t === 'function' || t === 'symbol' || t === 'undefined') return '"[Unserializable]"';
  if (depth >= MAX_SERIALIZE_DEPTH) return '"[MaxDepth]"';
  if (ancestors.includes(value)) return '"[Circular]"';
  ancestors.push(value);
  let out;
  try {
    if (Array.isArray(value)) {
      out = `[${value.map((v) => serializeLossy(v, ancestors, depth + 1)).join(',')}]`;
    } else {
      const parts = [];
      for (const [k, v] of Object.entries(value)) {
        parts.push(`${JSON.stringify(k)}:${serializeLossy(v, ancestors, depth + 1)}`);
      }
      out = `{${parts.join(',')}}`;
    }
  } catch (err) {
    out = '"[Unreadable]"';
  }
  ancestors.pop();
  return out;
}

// Every string in the schema reaches the agent as part of the tool
// definition: descriptions and titles, but also defaults, examples,
// $comment, and vendor x-* keys. A walk that only reads description/title
// leaves all of those as clean hiding places. Strings under default,
// examples, const and enum are data the page supplies, so they are scanned
// like everything else but never count toward the description size budget.
const SCHEMA_DATA_KEYS = new Set(['default', 'examples', 'const', 'enum']);
const MAX_SCHEMA_DEPTH = 12;

// Walks the schema and collects every string with the path it was found at
// and a kind: 'name' for a property name, 'key' for any other object key,
// 'description' for a schema description, 'value' for everything else.
// Bounded by depth and by a shared character budget so a hostile schema
// cannot turn the walk itself into the DoS.
function collectSchemaStrings(schema, budgetChars) {
  const out = [];
  let budget = budgetChars;
  let truncated = false;

  const take = (path, text, kind) => {
    if (budget <= 0) {
      truncated = true;
      return;
    }
    let clipped = text;
    if (text.length > budget) {
      clipped = text.slice(0, budget);
      truncated = true;
    }
    budget -= clipped.length;
    out.push({ path, text: clipped, kind });
  };

  const visit = (node, path, ancestors, depth, inData) => {
    if (typeof node === 'string') {
      take(path, node, 'value');
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (depth > MAX_SCHEMA_DEPTH) {
      truncated = true;
      return;
    }
    if (ancestors.includes(node)) return;
    ancestors.push(node);
    let entries;
    try {
      entries = Object.entries(node);
    } catch (err) {
      ancestors.pop();
      return;
    }
    const isArray = Array.isArray(node);
    for (const [key, value] of entries) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const childPath = isArray ? `${path}[${key}]` : `${path}.${key}`;
      if (!isArray) take(`${childPath} (key)`, key, 'key');
      if (!inData && key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
        let propEntries;
        try {
          propEntries = Object.entries(value);
        } catch (err) {
          continue;
        }
        for (const [propName, spec] of propEntries) {
          if (budget <= 0) break;
          take(`${path}.properties (property name)`, propName, 'name');
          visit(spec, `${childPath}.${propName}`, ancestors, depth + 1, false);
        }
      } else if (typeof value === 'string') {
        take(childPath, value, !inData && !isArray && key === 'description' ? 'description' : 'value');
      } else if (value && typeof value === 'object') {
        visit(value, childPath, ancestors, depth + 1, inData || (!isArray && SCHEMA_DATA_KEYS.has(key)));
      }
    }
    ancestors.pop();
  };

  visit(schema, 'inputSchema', [], 0, false);
  return { strings: out, truncated };
}

export function lintTool(tool) {
  const t = tool && typeof tool === 'object' ? tool : {};
  const name = typeof t.name === 'string' ? t.name : '';
  const title = typeof t.title === 'string' ? t.title : '';
  const description = typeof t.description === 'string' ? t.description : '';
  const annotations = t.annotations && typeof t.annotations === 'object' ? t.annotations : {};
  const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {};
  const findings = [];

  // Cap what the pattern scans read. The whole point of this linter is to look
  // at hostile, page-controlled metadata, so a page can hand us a megabyte of
  // text purely to make the regex work expensive. 16 KB is far more than any
  // real tool field needs; anything past it is scanned truncated and the
  // truncation is reported as its own finding. The name gets the same cap as
  // everything else: it flows into the injection loop, the code-point scan,
  // and the word splitter, all of which are linear-or-worse in its length.
  const MAX_SCAN = 16384;
  // Chrome's published per-field size budgets (see the budget findings below).
  const NAME_BUDGET = 30;
  const DESCRIPTION_BUDGET = 500;
  const PARAM_DESCRIPTION_BUDGET = 150;
  const { json: schemaJson, unserializable, reason: unserializableReason } = safeSchemaJson(schema);
  const nameScan = name.length > MAX_SCAN ? name.slice(0, MAX_SCAN) : name;
  const titleScan = title.length > MAX_SCAN ? title.slice(0, MAX_SCAN) : title;
  const descScan = description.length > MAX_SCAN ? description.slice(0, MAX_SCAN) : description;
  const schemaScan = schemaJson.length > MAX_SCAN ? schemaJson.slice(0, MAX_SCAN) : schemaJson;
  const nameDisplay = name.length > 80 ? `${name.slice(0, 77)}...` : name;

  if (unserializable) {
    findings.push(finding('unserializable', 'medium', 'Input schema cannot be serialized',
      `JSON.stringify on this schema threw (${unserializableReason}). A circular reference or exotic value in a tool schema is a strong sign the page is trying to break inspection tooling; the schema was scanned in a degraded form.`));
  }
  const degraded = Array.isArray(t.degraded) ? t.degraded.filter((f) => typeof f === 'string') : [];
  if (degraded.length > 0) {
    const fields = degraded.join(', ');
    findings.push(finding('unserializable', 'medium', `Tool metadata could not be relayed intact (${fields})`,
      `The page put a value in this tool's ${fields} that cannot cross the extension's message channel (a BigInt, a circular reference, or a function). The panel received a lossy copy with those values replaced by markers, and everything here was linted from that copy. Values like these in tool metadata are a strong sign the page is trying to break inspection tooling.`));
  }

  // Name, title and description are the strings the agent actually reads, so
  // injection phrasing there lands directly in its context.
  for (const [fieldName, value] of [['name', nameScan], ['title', titleScan], ['description', descScan]]) {
    for (const [, severity, title, detail] of injectionHits(value)) {
      findings.push(finding('inject', severity, `${title} (${fieldName})`, detail));
    }
  }

  // Zero-width and bidi characters survive copy-paste but never render, which is
  // what makes them the classic carrier for hidden instructions.
  findings.push(...scanUnicode('name', nameScan));
  findings.push(...scanUnicode('title', titleScan));
  findings.push(...scanUnicode('description', descScan));

  // Every schema string and key reaches the agent verbatim as part of the
  // tool definition, so it gets the exact same injection and hidden-Unicode
  // treatment as the top-level fields. Findings
  // carry the path (e.g. inputSchema.properties.text.description); titles stay
  // coarse so one payload repeated across ten properties dedupes to one finding.
  const { strings: schemaStrings, truncated: schemaWalkTruncated } = collectSchemaStrings(schema, MAX_SCAN);
  const schemaFindings = [];
  for (const { path, text } of schemaStrings) {
    for (const [, severity, title, detail] of injectionHits(text)) {
      schemaFindings.push(finding('inject', severity, `${title} (inputSchema)`, `At ${path}: ${detail}`));
    }
    schemaFindings.push(...scanUnicode('inputSchema', text, path));
  }
  findings.push(...dedupeByTitle(schemaFindings));

  const sinkHit = SINK.exec(patternText(titleScan)) || SINK.exec(patternText(descScan)) || SINK.exec(patternText(schemaScan));
  if (sinkHit) {
    findings.push(finding('sink', 'high', 'References a data-collection endpoint',
      `Mentions "${sinkHit[0]}", a paste/webhook/tunnel endpoint whose purpose is receiving data out-of-band.`));
  }

  if (SECRET.test(patternText(titleScan)) || SECRET.test(patternText(descScan)) || SECRET.test(patternText(schemaScan))) {
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
  const nameWords = nameScan.split(/[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
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
  if (dangerText.test(descScan) || dangerName.test(nameScan) || dangerPair) {
    findings.push(finding('capability', 'high', 'Exposes arbitrary code or command execution',
      'This tool appears to run arbitrary commands, code, or queries. Exposed to an agent, any successful injection becomes remote code execution. Constrain it to specific, named operations.'));
  } else if (loneDanger) {
    findings.push(finding('capability', 'low', 'Name hints at command or code execution',
      `"${nameDisplay}" contains an execution-related word (exec, eval, shell, or system). On its own that is only a naming smell, but if this tool does run commands or code, constrain it to specific, named operations and describe it accurately.`));
  }

  if (isReadShaped(nameScan) && annotations.readOnlyHint !== true) {
    findings.push(finding('mismatch', 'low', 'Read-shaped name is not marked read-only',
      `"${nameDisplay}" reads like a lookup but readOnlyHint is not set. If it does mutate state the name is misleading; if it does not, set readOnlyHint so agents can treat it safely.`));
  }

  // A tool that reads as pulling in content from outside the page (a fetched
  // page, scraped text, another user's content) should mark
  // untrustedContentHint so callers treat the result as data, not directives.
  // Whatever it returns can carry its own injected instructions.
  const untrustedContentMatch = UNTRUSTED_CONTENT_TEXT.exec(descScan) || UNTRUSTED_CONTENT_TEXT.exec(nameScan);
  if (untrustedContentMatch && annotations.untrustedContentHint !== true) {
    findings.push(finding('untrusted-missing', 'medium', 'Handles external content without untrustedContentHint',
      `"${nameDisplay}" reads as handling outside content ("${untrustedContentMatch[0]}") but annotations.untrustedContentHint is not true. Whatever it returns can carry its own instructions aimed at the agent.`));
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
  if (name.length > MAX_SCAN || title.length > MAX_SCAN || description.length > MAX_SCAN || schemaJson.length > MAX_SCAN || schemaWalkTruncated) {
    findings.push(finding('truncated', 'low', 'Oversized tool metadata (scanned first 16 KB)',
      'The name, description, or schema is larger than 16 KB (or the schema nests deeper than the scan limit), so only part of it was scanned for injection and exfiltration patterns. Oversized tool metadata is itself unusual for a legitimate tool.'));
  }

  // Chrome's published WebMCP size budgets: 30 chars for a tool or parameter
  // name, 500 for a tool description, 150 for a parameter description. These
  // are style findings, not security ones -- but content past the budget can
  // be cut before the agent ever sees it, so a reviewer reading the full text
  // is reviewing something the agent may never act on in that form.
  if (name.length > NAME_BUDGET) {
    findings.push(finding('budget-name', 'low', 'Tool name is over the 30-character budget',
      `"${nameDisplay}" has a ${name.length}-character name, over Chrome's ${NAME_BUDGET}-character budget for a tool name.`));
  }
  if (description.length > DESCRIPTION_BUDGET) {
    findings.push(finding('budget-description', 'medium', 'Tool description is over the 500-character budget',
      `"${nameDisplay}" has a ${description.length}-character description, over Chrome's ${DESCRIPTION_BUDGET}-character budget. Anything past the budget can be cut before the agent reads it.`));
  }
  const paramBudgetFindings = [];
  for (const { path, text, kind } of schemaStrings) {
    if (kind === 'name') {
      if (text.length > NAME_BUDGET) {
        paramBudgetFindings.push(finding('budget-param-name', 'low', 'Parameter name is over the 30-character budget',
          `"${text}" is a ${text.length}-character parameter name, over Chrome's ${NAME_BUDGET}-character budget.`));
      }
    } else if (kind === 'description') {
      if (text.length > PARAM_DESCRIPTION_BUDGET) {
        paramBudgetFindings.push(finding('budget-param-description', 'medium', 'Parameter description is over the 150-character budget',
          `The description at ${path} is ${text.length} characters, over Chrome's ${PARAM_DESCRIPTION_BUDGET}-character budget for a parameter description. Anything past the budget can be cut before the agent reads it.`));
      }
    }
  }
  findings.push(...dedupeByTitle(paramBudgetFindings));

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
