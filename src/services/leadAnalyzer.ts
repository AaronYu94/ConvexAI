import type { BotConfig, LeadScoreResult } from "../types";
import { canonicalizeLeadTags, scoreLeadIntent } from "./leadScorer";

function extractOutputText(payload: any): string {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (block?.type === "output_text" && typeof block.text === "string") {
        return block.text.trim();
      }
    }
  }

  return "";
}

function parseJsonObject(raw: string): any | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeResult(payload: any, fallback: LeadScoreResult): LeadScoreResult {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const llmTags = Array.isArray(payload.tags)
    ? payload.tags.filter((tag: unknown): tag is string => typeof tag === "string")
    : [];
  const llmReasons = Array.isArray(payload.reasons)
    ? payload.reasons.filter((reason: unknown): reason is string => typeof reason === "string")
    : [];
  const llmScore = typeof payload.score === "number" ? Math.max(0, Math.min(100, Math.round(payload.score))) : 0;
  const combinedTags = canonicalizeLeadTags([...fallback.tags, ...llmTags], Math.max(fallback.score, llmScore));
  const combinedReasons = [...new Set([...fallback.reasons, ...llmReasons])];
  const score = Math.max(fallback.score, llmScore);

  return {
    score,
    tags: combinedTags,
    reasons: combinedReasons,
    shouldNotify: Boolean(payload.shouldNotify) || fallback.shouldNotify || score >= 40,
    suggestedAction:
      typeof payload.suggestedAction === "string" && payload.suggestedAction.trim()
        ? payload.suggestedAction.trim()
        : fallback.suggestedAction,
    summary:
      typeof payload.summary === "string" && payload.summary.trim()
        ? payload.summary.trim()
        : fallback.summary,
    confidence:
      typeof payload.confidence === "number"
        ? Math.max(0, Math.min(1, payload.confidence))
        : Math.max(fallback.confidence, 0.6),
    source: "hybrid"
  };
}

export class LeadAnalyzer {
  constructor(private readonly config: BotConfig) {}

  async analyze(messageContent: string): Promise<LeadScoreResult> {
    const fallback = scoreLeadIntent(messageContent);
    if (!this.config.openAiApiKey) {
      return fallback;
    }

    const instructions = [
      "You classify Discord messages for community ops and sales follow-up.",
      "Detect operational tags such as high_intent, ready_to_grow, support_issue, needs_your_call, community_feedback, event_candidate, needs_followup.",
      "Return strict JSON with keys: score, tags, reasons, shouldNotify, suggestedAction, summary, confidence.",
      "Score must be 0-100. shouldNotify should be true only for meaningful lead or urgent support follow-up."
    ].join(" ");

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.openAiApiKey}`
      },
      body: JSON.stringify({
        model: this.config.analysisModel,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: instructions
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Message:\n${messageContent}`
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      return fallback;
    }

    const payload = await response.json();
    const outputText = extractOutputText(payload);
    const json = parseJsonObject(outputText);
    return normalizeResult(json, fallback);
  }
}
