import type { BotConfig } from "../types";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function extractEmbeddings(payload: any): number[][] {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .map((row: any) => (Array.isArray(row?.embedding) ? row.embedding.filter(isFiniteNumber) : []))
    .filter((embedding: number[]) => embedding.length > 0);
}

export function toVectorLiteral(values: number[]): string {
  return `[${values.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

export class EmbeddingClient {
  constructor(private readonly config: BotConfig) {}

  isEnabled(): boolean {
    return Boolean(this.config.openAiApiKey);
  }

  async embedTexts(inputs: string[]): Promise<number[][]> {
    if (!this.config.openAiApiKey) {
      return [];
    }

    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.openAiApiKey}`
      },
      body: JSON.stringify({
        model: this.config.embeddingModel,
        input: inputs,
        dimensions: this.config.embeddingDimensions
      })
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status} ${await response.text()}`);
    }

    const payload = await response.json();
    return extractEmbeddings(payload);
  }

  async embedText(input: string): Promise<number[] | null> {
    const embeddings = await this.embedTexts([input]);
    return embeddings[0] ?? null;
  }
}
