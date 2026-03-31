import type { GeneratedAnswer, KnowledgeSearchResult } from "../types";

export interface AnswerWorkflowDecision {
  shouldEscalate: boolean;
  reason?: string;
  userFacingMessage?: string;
}

function looksChinese(input: string): boolean {
  return /[\p{Script=Han}]/u.test(input);
}

function containsEscalationLanguage(input: string): boolean {
  const normalized = input.toLowerCase();
  const patterns = [
    "human follow-up",
    "human teammate",
    "context is incomplete",
    "not enough information",
    "could not find a grounded answer",
    "need a human",
    "人工",
    "转人工",
    "信息不完整",
    "无法确认"
  ];

  return patterns.some((pattern) => normalized.includes(pattern));
}

function buildEscalationMessage(question: string): string {
  if (looksChinese(question)) {
    return "这个问题我先交给人工同事处理。我已经整理好你的问题、相关上下文和当前草稿，团队会尽快跟进。";
  }

  return "I am handing this question to a human teammate. I have packaged the question, context, and current draft so they can follow up quickly.";
}

export function decideAnswerWorkflow(
  question: string,
  results: KnowledgeSearchResult[],
  answer: GeneratedAnswer
): AnswerWorkflowDecision {
  if (results.length === 0) {
    return {
      shouldEscalate: true,
      reason: "No grounded knowledge matched this question.",
      userFacingMessage: buildEscalationMessage(question)
    };
  }

  if (answer.usedFallback) {
    return {
      shouldEscalate: true,
      reason: "The answer path fell back instead of producing a confident grounded response.",
      userFacingMessage: buildEscalationMessage(question)
    };
  }

  const strongestResultScore = results[0]?.score ?? 0;
  if (results.length < 2 && strongestResultScore < 6) {
    return {
      shouldEscalate: true,
      reason: "Knowledge match was too weak to safely answer without a human check.",
      userFacingMessage: buildEscalationMessage(question)
    };
  }

  if (containsEscalationLanguage(answer.text)) {
    return {
      shouldEscalate: true,
      reason: "The draft answer explicitly signaled uncertainty or human follow-up.",
      userFacingMessage: buildEscalationMessage(question)
    };
  }

  return {
    shouldEscalate: false
  };
}
