import type { ModerationResult } from "../types";

const BLOCK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /free\s+nitro/i,
    reason: "Possible giveaway scam."
  },
  {
    pattern: /(discord\.gg|t\.me|bit\.ly|tinyurl\.com)/i,
    reason: "Contains a suspicious short or invite link."
  },
  {
    pattern: /\bairdrop\b/i,
    reason: "Contains common spam vocabulary."
  },
  {
    pattern: /@everyone|@here/i,
    reason: "Abuses mass mentions."
  }
];

export function moderateMessage(messageContent: string): ModerationResult {
  const normalized = messageContent.trim();

  if (!normalized) {
    return {
      shouldBlock: false,
      severity: "none"
    };
  }

  for (const rule of BLOCK_PATTERNS) {
    if (rule.pattern.test(normalized)) {
      return {
        shouldBlock: true,
        severity: "delete",
        reason: rule.reason
      };
    }
  }

  const urlMatches = normalized.match(/https?:\/\//gi) ?? [];
  if (urlMatches.length >= 3) {
    return {
      shouldBlock: true,
      severity: "delete",
      reason: "Contains too many links."
    };
  }

  return {
    shouldBlock: false,
    severity: "none"
  };
}
