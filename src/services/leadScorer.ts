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
  },
  {
    tag: "community_feedback",
    points: 12,
    reason: "Shared product or community feedback.",
    patterns: [/\bfeedback\b/i, /\bfeature request\b/i, /\brequest\b/i, /\bsuggestion\b/i, /\bwishlist\b/i, /建议/, /反馈/, /希望增加/, /能不能/, /吐槽/]
  },
  {
    tag: "event_candidate",
    points: 8,
    reason: "Mentioned a campaign or activity submission.",
    patterns: [/\bgiveaway\b/i, /\bcontest\b/i, /\bsubmission\b/i, /\bsubmit\b/i, /\bentry\b/i, /活动/, /抽奖/, /投稿/, /提交/, /参赛/, /报名/]
  }
];

const HIGH_INTENT_SOURCE_TAGS = ["pricing_interest", "demo_interest", "enterprise_interest", "trial_interest"];

export function canonicalizeLeadTags(inputTags: string[], score = 0): string[] {
  const tags = new Set<string>();
  const sourceTags = new Set(inputTags);

  if (HIGH_INTENT_SOURCE_TAGS.some((tag) => sourceTags.has(tag)) || sourceTags.has("high_intent")) {
    tags.add("high_intent");
  }

  if (
    sourceTags.has("integration_interest") ||
    sourceTags.has("technical_user") ||
    sourceTags.has("ready_to_grow")
  ) {
    tags.add("ready_to_grow");
  }

  if (sourceTags.has("support_issue")) {
    tags.add("support_issue");
    tags.add("needs_your_call");
  }

  if (sourceTags.has("community_feedback")) {
    tags.add("community_feedback");
  }

  if (sourceTags.has("event_candidate")) {
    tags.add("event_candidate");
  }

  if (sourceTags.has("spam_risk")) {
    tags.add("spam_risk");
  }

  if (sourceTags.has("needs_human_review") || sourceTags.has("needs_your_call")) {
    tags.add("needs_your_call");
  }

  if (sourceTags.has("needs_followup") || tags.has("high_intent") || score >= 40) {
    tags.add("needs_followup");
  }

  const passthroughTags = ["core_member", "active_user", "community_member", "going_cold"];
  for (const tag of passthroughTags) {
    if (sourceTags.has(tag)) {
      tags.add(tag);
    }
  }

  return [...tags];
}

function getSuggestedAction(tags: string[]): string {
  if (tags.includes("spam_risk")) {
    return "Remove or review the message and decide whether the sender should be restricted.";
  }

  if (tags.includes("event_candidate")) {
    return "Review the activity submission and keep only entries that match the campaign rules.";
  }

  if (tags.includes("needs_your_call")) {
    return "Collect the needed debugging details and route the case to support or engineering.";
  }

  if (tags.includes("high_intent")) {
    return "Flag this user for human follow-up on demo, pricing, or purchase intent.";
  }

  if (tags.includes("ready_to_grow")) {
    return "Guide the user through setup, integration, or rollout so they can adopt the product smoothly.";
  }

  if (tags.includes("going_cold")) {
    return "Nudge this member before interest fades further and decide whether a human should step in.";
  }

  if (tags.includes("community_feedback")) {
    return "Capture the feedback and decide whether product or community ops should respond.";
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

  const dedupedTags = canonicalizeLeadTags([...new Set(tags)], score);
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
