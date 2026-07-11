// core/worstSeverity.js
//
// Pure severity-ranking helpers shared by the panel UI and the tests. No
// chrome.* dependency. `lint.js` findings carry a `severity` string; these
// helpers turn a findings array into "the one badge to show" and "the order
// to list them in" without caring where the findings came from.

export const SEVERITY_ORDER = Object.freeze(['critical', 'high', 'medium', 'low', 'info']);

const RANK = new Map(SEVERITY_ORDER.map((sev, i) => [sev, i]));
const UNKNOWN_RANK = SEVERITY_ORDER.length; // sorts after every known severity, never dropped

function rankOf(severity) {
  return RANK.has(severity) ? RANK.get(severity) : UNKNOWN_RANK;
}

/**
 * Returns the worst (highest-priority) severity in a findings array, or null
 * if there are no findings. Never throws on malformed entries.
 * @param {Array<{severity?: unknown}>} findings
 * @returns {string | null}
 */
export function worstSeverity(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return null;

  let worst = null;
  let worstRank = Infinity;
  for (const finding of findings) {
    const sev = finding && typeof finding.severity === 'string' ? finding.severity : 'info';
    const rank = rankOf(sev);
    if (rank < worstRank) {
      worstRank = rank;
      worst = sev;
    }
  }
  return worst;
}

/**
 * Array.prototype.sort comparator: worst severity first. Findings with an
 * unrecognized/missing severity sort last, but are kept, not dropped.
 * @param {{severity?: unknown}} a
 * @param {{severity?: unknown}} b
 * @returns {number}
 */
export function bySeverityDesc(a, b) {
  const sevA = a && typeof a.severity === 'string' ? a.severity : undefined;
  const sevB = b && typeof b.severity === 'string' ? b.severity : undefined;
  return rankOf(sevA) - rankOf(sevB);
}
