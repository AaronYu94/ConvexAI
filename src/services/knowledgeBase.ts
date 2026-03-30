import type { KnowledgeChunk, KnowledgeDocument, KnowledgeSearchResult } from "../types";

const HEADING_PATTERN = /^#{1,3}\s+(.+)$/gm;
const MAX_CHUNK_LENGTH = 1200;

function buildHanBigrams(input: string): string[] {
  if (input.length < 2) {
    return [input];
  }

  const output: string[] = [];
  for (let index = 0; index < input.length - 1; index += 1) {
    output.push(input.slice(index, index + 2));
  }

  return output;
}

export function tokenize(input: string): string[] {
  const normalized = input.toLowerCase();
  const latinTokens = normalized.match(/[a-z0-9]{2,}/g) ?? [];
  const hanGroups = [...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)].map((match) => match[0]);
  const hanTokens = hanGroups.flatMap(buildHanBigrams);
  return [...new Set([...latinTokens, ...hanTokens])];
}

function createChunk(
  document: KnowledgeDocument,
  suffix: string,
  title: string,
  content: string
): KnowledgeChunk | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  return {
    id: `${document.id}:${suffix}`,
    title,
    source: document.source,
    content: normalized,
    tokens: tokenize(`${title}\n${normalized}`)
  };
}

function chunkMarkdownDocument(document: KnowledgeDocument): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const matches = [...document.content.matchAll(HEADING_PATTERN)];

  if (matches.length === 0) {
    const chunk = createChunk(document, "root", document.title, document.content);
    return chunk ? [chunk] : [];
  }

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const title = current[1].trim();
    const sectionStart = current.index ?? 0;
    const contentStart = sectionStart + current[0].length;
    const contentEnd = next?.index ?? document.content.length;
    const content = document.content.slice(contentStart, contentEnd).trim();
    const chunk = createChunk(document, String(index + 1), title, content);
    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

function chunkPlainDocument(document: KnowledgeDocument): KnowledgeChunk[] {
  const paragraphs = document.content
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    const chunk = createChunk(document, "root", document.title, document.content);
    return chunk ? [chunk] : [];
  }

  const chunks: KnowledgeChunk[] = [];
  let buffer = "";
  let partIndex = 1;

  for (const paragraph of paragraphs) {
    const next = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (next.length > MAX_CHUNK_LENGTH && buffer) {
      const chunk = createChunk(document, String(partIndex), `${document.title} Part ${partIndex}`, buffer);
      if (chunk) {
        chunks.push(chunk);
      }
      buffer = paragraph;
      partIndex += 1;
      continue;
    }

    buffer = next;
  }

  if (buffer) {
    const chunk = createChunk(document, String(partIndex), `${document.title} Part ${partIndex}`, buffer);
    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

export function buildKnowledgeChunks(documents: KnowledgeDocument[]): KnowledgeChunk[] {
  return documents.flatMap((document) =>
    document.contentType === "markdown" ? chunkMarkdownDocument(document) : chunkPlainDocument(document)
  );
}

export function searchKnowledgeBase(
  chunks: KnowledgeChunk[],
  query: string,
  limit = 3
): KnowledgeSearchResult[] {
  const queryTokens = tokenize(query);
  const queryTokenSet = new Set(queryTokens);
  const normalizedQuery = query.toLowerCase();

  return chunks
    .map((chunk) => {
      const matchedTerms = chunk.tokens.filter((token) => queryTokenSet.has(token));
      const overlap = matchedTerms.length;
      const exactBoost = chunk.content.toLowerCase().includes(normalizedQuery) ? 4 : 0;
      const titleBoost = chunk.title.toLowerCase().includes(normalizedQuery) ? 5 : 0;
      const score = overlap * 3 + exactBoost + titleBoost;

      return {
        chunk,
        score,
        matchedTerms
      };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function renderKnowledgeContext(results: KnowledgeSearchResult[]): string {
  return results
    .map((result, index) => {
      return `Source ${index + 1}: ${result.chunk.source} / ${result.chunk.title}\n${result.chunk.content}`;
    })
    .join("\n\n");
}
