import type { BotConfig, KnowledgeChunk, KnowledgeSearchResult } from "../types";
import { EmbeddingClient } from "./embeddings";
import { buildKnowledgeChunks, searchKnowledgeBase } from "./knowledgeBase";
import { loadKnowledgeDocuments } from "./knowledgeImporter";
import { PostgresKnowledgeStore } from "./postgresKnowledgeStore";

export class KnowledgeEngine {
  private chunks: KnowledgeChunk[] = [];
  private readonly embeddings: EmbeddingClient;
  private readonly vectorStore?: PostgresKnowledgeStore;

  constructor(private readonly config: BotConfig) {
    this.embeddings = new EmbeddingClient(config);
    this.vectorStore = config.databaseUrl ? new PostgresKnowledgeStore(config.databaseUrl) : undefined;
  }

  async init(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<number> {
    const documents = await loadKnowledgeDocuments(this.config.knowledgeDir, this.config.knowledgeSourcesFile);
    this.chunks = buildKnowledgeChunks(documents);

    if (this.vectorStore && this.embeddings.isEnabled() && this.chunks.length > 0) {
      try {
        const batchSize = 16;
        for (let index = 0; index < this.chunks.length; index += batchSize) {
          const slice = this.chunks.slice(index, index + batchSize);
          const embeddings = await this.embeddings.embedTexts(
            slice.map((chunk) => `${chunk.title}\n${chunk.content}`.slice(0, 8000))
          );
          if (embeddings.length === slice.length) {
            await this.vectorStore.upsertChunks(slice, embeddings);
          }
        }
      } catch (error) {
        console.warn("Vector indexing failed; continuing with lexical search.", error);
      }
    }

    return this.chunks.length;
  }

  getChunkCount(): number {
    return this.chunks.length;
  }

  getChunkSourceSummary(): Array<{ source: string; chunkCount: number; titles: string[] }> {
    const groups = new Map<string, { source: string; chunkCount: number; titles: Set<string> }>();

    for (const chunk of this.chunks) {
      const group = groups.get(chunk.source) ?? {
        source: chunk.source,
        chunkCount: 0,
        titles: new Set<string>()
      };

      group.chunkCount += 1;
      group.titles.add(chunk.title);
      groups.set(chunk.source, group);
    }

    return [...groups.values()]
      .map((group) => ({
        source: group.source,
        chunkCount: group.chunkCount,
        titles: [...group.titles].slice(0, 6)
      }))
      .sort((left, right) => right.chunkCount - left.chunkCount);
  }

  async search(query: string, limit = 4): Promise<KnowledgeSearchResult[]> {
    const lexicalResults = searchKnowledgeBase(this.chunks, query, limit + 2);

    if (!this.vectorStore || !this.embeddings.isEnabled()) {
      return lexicalResults.slice(0, limit);
    }

    try {
      const queryEmbedding = await this.embeddings.embedText(query);
      if (!queryEmbedding) {
        return lexicalResults.slice(0, limit);
      }

      const vectorResults = await this.vectorStore.search(query, queryEmbedding, limit + 2);
      if (vectorResults.length === 0) {
        return lexicalResults.slice(0, limit);
      }

      const merged = new Map<string, KnowledgeSearchResult>();

      for (const result of lexicalResults) {
        merged.set(result.chunk.id, result);
      }

      for (const result of vectorResults) {
        const existing = merged.get(result.chunk.id);
        if (!existing) {
          merged.set(result.chunk.id, result);
          continue;
        }

        merged.set(result.chunk.id, {
          chunk: existing.chunk,
          matchedTerms: [...new Set([...existing.matchedTerms, ...result.matchedTerms])],
          score: existing.score + result.score
        });
      }

      return [...merged.values()]
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    } catch (error) {
      console.warn("Vector search failed; falling back to lexical search.", error);
      return lexicalResults.slice(0, limit);
    }
  }

  async close(): Promise<void> {
    if (this.vectorStore) {
      await this.vectorStore.close();
    }
  }
}
