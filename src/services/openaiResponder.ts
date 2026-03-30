import type { BotConfig, GeneratedAnswer, KnowledgeSearchResult } from "../types";
import { renderKnowledgeContext } from "./knowledgeBase";

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

function buildFallback(question: string, results: KnowledgeSearchResult[]): GeneratedAnswer {
  if (results.length === 0) {
    return {
      text: [
        "I could not find a grounded answer in the current knowledge base.",
        "Please have a human teammate follow up, or add the missing FAQ entry.",
        `Original question: ${question}`
      ].join("\n"),
      usedFallback: true
    };
  }

  const bullets = results
    .map((result) => `- ${result.chunk.title}: ${result.chunk.content.replace(/\s+/g, " ").slice(0, 180)}...`)
    .join("\n");

  return {
    text: [
      "I do not have an OpenAI key configured yet, so this is a grounded fallback summary from the knowledge base:",
      bullets,
      "If you want a more polished answer, add OPENAI_API_KEY in .env."
    ].join("\n"),
    usedFallback: true
  };
}

export class OpenAIResponder {
  constructor(private readonly config: BotConfig) {}

  async answer(question: string, results: KnowledgeSearchResult[]): Promise<GeneratedAnswer> {
    if (!this.config.openAiApiKey) {
      return buildFallback(question, results);
    }

    try {
      const context = renderKnowledgeContext(results);
      const instructions = [
        `You are ${this.config.botName}, an AI community operations assistant for a Discord server.`,
        "Answer with a concise, helpful Discord-ready response.",
        "Respond in the same language the user used unless they explicitly ask for another language.",
        "Only use the supplied context. Do not invent product details, pricing commitments, or roadmap promises.",
        "If the context is incomplete, say so clearly and suggest a human follow-up.",
        "If the user sounds high-intent, end with one practical next step."
      ].join(" ");

      const userPrompt = [
        `Question: ${question}`,
        "",
        "Grounding context:",
        context || "No context found."
      ].join("\n");

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.openAiApiKey}`
        },
        body: JSON.stringify({
          model: this.config.openAiModel,
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
                  text: userPrompt
                }
              ]
            }
          ]
        })
      });

      if (!response.ok) {
        const fallback = buildFallback(question, results);
        const errorText = await response.text();
        return {
          text: [
            "The OpenAI call failed, so I am falling back to a local summary.",
            `Reason: ${errorText.slice(0, 180)}`,
            "",
            fallback.text
          ].join("\n"),
          usedFallback: true
        };
      }

      const payload = await response.json();
      const outputText = extractOutputText(payload);

      if (!outputText) {
        return buildFallback(question, results);
      }

      return {
        text: outputText,
        usedFallback: false
      };
    } catch (error) {
      const fallback = buildFallback(question, results);
      return {
        text: [
          "The OpenAI call could not be completed, so I am falling back to a local summary.",
          "",
          fallback.text
        ].join("\n"),
        usedFallback: true
      };
    }
  }
}
