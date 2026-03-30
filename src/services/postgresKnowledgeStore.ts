import { Pool } from "pg";
import type { KnowledgeChunk, KnowledgeSearchResult } from "../types";
import { toVectorLiteral } from "./embeddings";
import { tokenize } from "./knowledgeBase";

function rowToSearchResult(row: any, query: string): KnowledgeSearchResult {
  const chunk: KnowledgeChunk = {
    id: row.id,
    source: row.source,
    title: row.title,
    content: row.content,
    tokens: tokenize(`${row.title}\n${row.content}`)
  };

  const queryTokens = new Set(tokenize(query));
  const matchedTerms = chunk.tokens.filter((token) => queryTokens.has(token));

  return {
    chunk,
    score: Math.round(Number(row.score ?? 0) * 100),
    matchedTerms
  };
}

export class PostgresKnowledgeStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl
    });
  }

  async upsertChunks(chunks: KnowledgeChunk[], embeddings: number[][]): Promise<void> {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const embedding = embeddings[index];
      await this.pool.query(
        `
          insert into knowledge_chunks (id, source, title, content, embedding, updated_at)
          values ($1, $2, $3, $4, $5::vector, now())
          on conflict (id) do update
          set source = excluded.source,
              title = excluded.title,
              content = excluded.content,
              embedding = excluded.embedding,
              updated_at = now()
        `,
        [chunk.id, chunk.source, chunk.title, chunk.content, embedding ? toVectorLiteral(embedding) : null]
      );
    }
  }

  async search(query: string, queryEmbedding: number[], limit = 4): Promise<KnowledgeSearchResult[]> {
    const result = await this.pool.query(
      `
        select id, source, title, content, 1 - (embedding <=> $1::vector) as score
        from knowledge_chunks
        where embedding is not null
        order by embedding <=> $1::vector
        limit $2
      `,
      [toVectorLiteral(queryEmbedding), limit]
    );

    return result.rows.map((row) => rowToSearchResult(row, query));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
