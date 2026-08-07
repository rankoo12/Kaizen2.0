/**
 * Init Brief intake — secret scrubbing.
 * Spec: docs/specs/test-writer/spec-test-writer-service.md §12, §13.1
 *
 * People paste whatever is on their clipboard into a "describe your app" box,
 * and that regularly includes credentials. Scrub BEFORE storage and before the
 * text reaches any prompt: an API key that never enters the system cannot leak
 * from it.
 */

export type ScrubResult = {
  text: string;
  /** Human-readable labels of what was redacted, for the API response warning. */
  redactions: string[];
};

const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: 'Kaizen API key', re: /\bkzn_live_[A-Za-z0-9]{8,}\b/g },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{12,}\b/g },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { label: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: 'connection string with credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi },
  // "password: hunter2", "pwd = hunter2", "api_key: abc123"
  { label: 'inline credential', re: /\b(?:pass(?:word|wd)?|pwd|secret|api[_-]?key|token|credentials?)\s*[:=]\s*\S+/gi },
];

const REDACTED = '[REDACTED]';

export function scrubSecrets(input: string): ScrubResult {
  let text = input;
  const redactions: string[] = [];

  for (const { label, re } of PATTERNS) {
    if (re.test(text)) {
      redactions.push(label);
      text = text.replace(re, (match) => {
        // Keep the key name so the sentence still reads ("password: [REDACTED]").
        const keyed = match.match(/^([\w-]+)\s*[:=]/);
        return keyed ? `${keyed[1]}: ${REDACTED}` : REDACTED;
      });
    }
    re.lastIndex = 0;
  }

  return { text, redactions: [...new Set(redactions)] };
}

export const MAX_BRIEF_CHARS = 8_000;

/** Trims and scrubs a raw brief. Returns null when nothing usable remains. */
export function prepareBrief(raw: string | undefined | null): ScrubResult | null {
  if (!raw) return null;
  const trimmed = raw.trim().slice(0, MAX_BRIEF_CHARS);
  if (trimmed.length < 10) return null;
  return scrubSecrets(trimmed);
}
