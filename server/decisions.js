'use strict';
// Decision extraction: turns an assistant message into zero or more
// "choices Claude made" entries for the Decisions card.
//
// Documented interface (keep this stable so the extractor is swappable):
//   extractDecisions(text: string) -> Array<{ tag: 'Scope'|'Approach'|'Workaround'|'Design', text: string }>
//
// This is the v1 heuristic implementation: no LLM calls, just sentence
// splitting + verb/keyword matching. A future drop-in replacement (e.g. a
// Haiku-powered extractor) should export the same function signature from
// this module so callers in reducer.js don't need to change.

const DECISION_VERBS = /\b(chose|opted|decided|instead of|worked around|working around|workaround|rather than|skipping|skipped|added|falls?\s+back|fell back)\b/i;

const TAG_RULES = [
  { tag: 'Scope', re: /\b(scope|wasn't in the plan|was not in the plan|not in the plan|beyond the plan|outside the plan)\b/i },
  { tag: 'Workaround', re: /\b(workaround|work around|silently|bug in|blocks?\b|doesn't support|isn't supported)\b/i },
  { tag: 'Design', re: /\b(design|schema|structure|shared store|separate store|architecture)\b/i },
];

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tagFor(sentence) {
  for (const rule of TAG_RULES) {
    if (rule.re.test(sentence)) return rule.tag;
  }
  return 'Approach';
}

function extractDecisions(text) {
  if (!text || typeof text !== 'string') return [];
  const decisions = [];
  for (const sentence of splitSentences(text)) {
    if (sentence.length < 12 || sentence.length > 280) continue;
    if (!DECISION_VERBS.test(sentence)) continue;
    decisions.push({ tag: tagFor(sentence), text: sentence });
  }
  return decisions;
}

module.exports = { extractDecisions };
