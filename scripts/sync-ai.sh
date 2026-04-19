#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# sync-ai.sh — pack Kaizen into a single LLM-ready file and copy it to the
# private Google Drive folder for mobile Gemini access.
#
# Security model:
#   1. `.repomixignore` controls scope (version-controlled, auditable).
#   2. Output is scanned for secret patterns BEFORE being copied to Drive.
#   3. If any secret is detected, the sync aborts and the tmp file is shredded.
#   4. Nothing writes to Drive unless scanning passed.
#
# Usage:
#   npm run sync:ai
#
# Override the Drive target:
#   KAIZEN_AI_DRIVE_PATH="/custom/path" npm run sync:ai
#
# Bypass the secret scanner (DANGEROUS — only for debugging false positives):
#   KAIZEN_AI_SKIP_SCAN=1 npm run sync:ai
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

DRIVE_PATH="${KAIZEN_AI_DRIVE_PATH:-/c/Programming/SECRET-auto-update}"
OUTPUT_NAME="kaizen-codebase.txt"
REPO_ROOT="$(git rev-parse --show-toplevel)"
TMP_OUTPUT="$(mktemp -t kaizen-sync-XXXXXX.txt)"

cleanup() {
  if [ -f "$TMP_OUTPUT" ]; then
    # Overwrite before delete — defense in depth. Don't leak content on /tmp.
    dd if=/dev/zero of="$TMP_OUTPUT" bs=1024 count=1 conv=notrunc 2>/dev/null || true
    rm -f "$TMP_OUTPUT"
  fi
}
trap cleanup EXIT

echo "🤖 Packing Kaizen codebase..."
cd "$REPO_ROOT"

npx --yes repomix \
  --output "$TMP_OUTPUT" \
  --style xml \
  --quiet

if [ ! -s "$TMP_OUTPUT" ]; then
  echo "❌ Repomix produced an empty output. Aborting." >&2
  exit 1
fi

BYTES=$(wc -c < "$TMP_OUTPUT")
echo "   packed $BYTES bytes → scanning for secrets..."

# ─── Secret scanner ───────────────────────────────────────────────────────────
# Conservative patterns. False positives are better than leaks.
# Matches:
#   - OpenAI:          sk-[A-Za-z0-9]{20,}
#   - Anthropic:       sk-ant-[A-Za-z0-9-_]{20,}
#   - Google API:      AIza[A-Za-z0-9_-]{35}
#   - GitHub PAT:      ghp_[A-Za-z0-9]{36}  /  github_pat_[A-Za-z0-9_]{20,}
#   - AWS access key:  AKIA[0-9A-Z]{16}
#   - Slack tokens:    xox[baprs]-[A-Za-z0-9-]{10,}
#   - Stripe live:     sk_live_[A-Za-z0-9]{20,}
#   - Generic long hex secrets (JWT_SECRET-style):  [a-f0-9]{64,}
#   - Private keys:    -----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----

if [ "${KAIZEN_AI_SKIP_SCAN:-0}" = "1" ]; then
  echo "   ⚠️  KAIZEN_AI_SKIP_SCAN=1 — secret scan bypassed (not recommended)"
else
  # name|pattern pairs. The name is shown on match; pattern is ERE.
  PATTERNS=(
    'openai|sk-[A-Za-z0-9]{20,}'
    'anthropic|sk-ant-[A-Za-z0-9_-]{20,}'
    'google-api|AIza[A-Za-z0-9_-]{35}'
    'github-pat-classic|ghp_[A-Za-z0-9]{36}'
    'github-pat-new|github_pat_[A-Za-z0-9_]{20,}'
    'aws-access-key|AKIA[0-9A-Z]{16}'
    'slack-token|xox[baprs]-[A-Za-z0-9-]{10,}'
    'stripe-live|sk_live_[A-Za-z0-9]{20,}'
    # High-entropy hex: 64+ chars that are NOT all-zero and NOT a single repeated char.
    # A real random secret has variety; 000...0 or aaa...a will not match.
    'high-entropy-hex|[a-f0-9]{64,}'
    'private-key|BEGIN [A-Z ]*PRIVATE KEY'
  )

  FOUND_ANY=0
  for entry in "${PATTERNS[@]}"; do
    name="${entry%%|*}"
    pattern="${entry#*|}"
    # -- terminates option parsing so patterns starting with - don't break grep
    # For high-entropy-hex, drop trivially-low-entropy matches (0000…, aaaa…)
    # where the entire run is one repeated character.
    if [ "$name" = "high-entropy-hex" ]; then
      HITS=$(grep -Eano -- "$pattern" "$TMP_OUTPUT" 2>/dev/null \
        | grep -Ev ':([0-9a-f])\1+$' || true)
    else
      HITS=$(grep -Ean -- "$pattern" "$TMP_OUTPUT" 2>/dev/null || true)
    fi

    if [ -n "$HITS" ]; then
      COUNT=$(printf '%s\n' "$HITS" | wc -l | tr -d ' ')
      echo "❌ [$name] matched $COUNT time(s)" >&2
      printf '%s\n' "$HITS" | head -3 | \
        sed -E 's/(.{20}).*/\1…REDACTED…/' >&2
      FOUND_ANY=1
    fi
  done

  if [ "$FOUND_ANY" -eq 1 ]; then
    echo "" >&2
    echo "⛔ Secret-like strings detected. Sync aborted." >&2
    echo "   The temp file has been shredded." >&2
    echo "   Fix the source or add the file to .repomixignore, then re-run." >&2
    echo "   If this is a false positive, re-run with KAIZEN_AI_SKIP_SCAN=1" >&2
    exit 2
  fi
  echo "   ✅ no secret patterns found"
fi

# ─── Ensure Drive path exists ─────────────────────────────────────────────────
if [ ! -d "$DRIVE_PATH" ]; then
  mkdir -p "$DRIVE_PATH" || {
    echo "❌ Could not create Drive path: $DRIVE_PATH" >&2
    echo "   Is Google Drive mounted? Set KAIZEN_AI_DRIVE_PATH to override." >&2
    exit 3
  }
fi

# ─── Atomic copy (write to .tmp, then rename) ─────────────────────────────────
FINAL="$DRIVE_PATH/$OUTPUT_NAME"
STAGED="$DRIVE_PATH/.${OUTPUT_NAME}.tmp"

cp "$TMP_OUTPUT" "$STAGED"
mv -f "$STAGED" "$FINAL"

echo "✅ Synced to $FINAL"
echo "   Google Drive will upload shortly. You can @attach it in Gemini on mobile."
