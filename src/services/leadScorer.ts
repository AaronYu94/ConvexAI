import type { LeadScoreResult } from "../types";

interface LeadRule {
  tag: string;
  points: number;
  reason: string;
  patterns: RegExp[];
}

const LEAD_RULES: LeadRule[] = [
  {
    tag: "pricing_interest",
    points: 30,
    reason: "Asked about price or budget.",
    patterns: [/\bprice\b/i, /\bpricing\b/i, /\bcost\b/i, /\bquote\b/i, /how much/i, /预算/, /报价/, /价格/]
  },
  {
    tag: "demo_interest",
    points: 35,
    reason: "Requested a demo or walkthrough.",
    patterns: [/\bdemo\b/i, /\bwalkthrough\b/i, /\bshow me\b/i, /\bbook a call\b/i, /演示/, /试用/, /看看效果/]
  },
  {
    tag: "enterprise_interest",
    points: 35,
    reason: "Mentioned enterprise evaluation or team rollout.",
    patterns: [/\benterprise\b/i, /\bsecurity\b/i, /\bcompliance\b/i, /\bprocurement\b/i, /\bteam\b/i, /企业/, /采购/, /合规/, /安全/]
  },
  {
    tag: "integration_interest",
    points: 25,
    reason: "Asked about setup, API, or deployment.",
    patterns: [/\bintegration\b/i, /\bdeploy\b/i, /\bdeployment\b/i, /\bapi\b/i, /\bself-host/i, /部署/, /接入/, /接口/]
  },
  {
    tag: "trial_interest",
    points: 20,
    reason: "Asked about trial or pilot usage.",
    patterns: [/\btrial\b/i, /\bpilot\b/i, /\bproof of concept\b/i, /\bpoc\b/i, /试点/, /试运行/]
  },
  {
    tag: "technical_user",
    points: 10,
    reason: "Asked a technical implementation question.",
    patterns: [/\bsdk\b/i, /\bwebhook\b/i, /\boauth\b/i, /\bapi\b/i, /\bbug\b/i, /报错/, /接口/, /权限/]
  },
  {
    tag: "support_issue",
    points: 10,
    reason: "Raised a support or debugging issue.",
    patterns: [/\bissue\b/i, /\berror\b/i, /\bnot working\b/i, /\bfailed\b/i, /无法/, /不工作/, /出错/, /异常/]
  }
];

function getSuggestedAction(tags: string[]): string {
  if (tags.includes("demo_interest")) {
    return "Offer a demo booking link and notify sales.";
  }

  if (tags.includes("pricing_interest") || tags.includes("enterprise_interest")) {
    return "Route to a human for pricing or enterprise follow-up.";
  }

  if (tags.includes("integration_interest")) {
    return "Have a solutions or product teammate answer deployment questions.";
  }

  if (tags.includes("support_issue")) {
    return "Route to support or product engineering for follow-up.";
  }

  return "Monitor this user and follow up if they ask again.";
}

export function scoreLeadIntent(messageContent: string): LeadScoreResult {
  const reasons: string[] = [];
  const tags: string[] = [];
  let score = 0;

  for (const rule of LEAD_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(messageContent))) {
      score += rule.points;
      tags.push(rule.tag);
      reasons.push(rule.reason);
    }
  }

  const dedupedTags = [...new Set(tags)];
  const dedupedReasons = [...new Set(reasons)];
  const shouldNotify = score >= 40;

  return {
    score,
    tags: dedupedTags,
    reasons: dedupedReasons,
    shouldNotify,
    suggestedAction: getSuggestedAction(dedupedTags),
    summary:
      dedupedReasons.length > 0
        ? `Rule-based analysis detected: ${dedupedReasons.join(" ")}`
        : "Rule-based analysis found no strong buying signal.",
    confidence: dedupedReasons.length > 0 ? 0.68 : 0.45,
    source: "rules"
  };
}
