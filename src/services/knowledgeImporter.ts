import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { PDFParse } from "pdf-parse";
import type { KnowledgeDocument, KnowledgeSourceManifest, KnowledgeSourceItem } from "../types";

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".json", ".html", ".htm", ".pdf"]);

function normalizeText(input: string): string {
  return input.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function detectContentType(filePath: string): KnowledgeDocument["contentType"] | undefined {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".md":
      return "markdown";
    case ".txt":
      return "text";
    case ".json":
      return "json";
    case ".html":
    case ".htm":
      return "html";
    case ".pdf":
      return "pdf";
    default:
      return undefined;
  }
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

function htmlToText(rawHtml: string): { title: string; text: string } {
  const $ = cheerio.load(rawHtml);
  $("script, style, noscript").remove();
  const title = $("title").first().text().trim() || "Untitled page";
  const text = normalizeText($("body").text());
  return { title, text };
}

async function loadFileDocument(filePath: string, titleOverride?: string): Promise<KnowledgeDocument | null> {
  const contentType = detectContentType(filePath);
  if (!contentType) {
    return null;
  }

  if (contentType === "pdf") {
    const buffer = await readFile(filePath);
    const parser = new PDFParse({
      data: buffer
    });
    const parsed = await parser.getText();
    await parser.destroy();
    const text = normalizeText(parsed.text);
    if (!text) {
      return null;
    }

    return {
      id: path.relative(process.cwd(), filePath),
      title: titleOverride ?? path.basename(filePath, path.extname(filePath)),
      source: path.relative(process.cwd(), filePath),
      content: text,
      contentType
    };
  }

  const raw = await readFile(filePath, "utf8");

  if (contentType === "html") {
    const html = htmlToText(raw);
    if (!html.text) {
      return null;
    }

    return {
      id: path.relative(process.cwd(), filePath),
      title: titleOverride ?? html.title,
      source: path.relative(process.cwd(), filePath),
      content: html.text,
      contentType
    };
  }

  if (contentType === "json") {
    const parsed = JSON.parse(raw);
    const text = normalizeText(JSON.stringify(parsed, null, 2));
    return {
      id: path.relative(process.cwd(), filePath),
      title: titleOverride ?? path.basename(filePath, path.extname(filePath)),
      source: path.relative(process.cwd(), filePath),
      content: text,
      contentType
    };
  }

  const text = normalizeText(raw);
  if (!text) {
    return null;
  }

  return {
    id: path.relative(process.cwd(), filePath),
    title: titleOverride ?? path.basename(filePath, path.extname(filePath)),
    source: path.relative(process.cwd(), filePath),
    content: text,
    contentType
  };
}

async function loadRemoteDocument(source: KnowledgeSourceItem): Promise<KnowledgeDocument | null> {
  if (!source.url) {
    return null;
  }

  const response = await fetch(source.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${source.url}: ${response.status}`);
  }

  const contentTypeHeader = response.headers.get("content-type") ?? "";

  if (contentTypeHeader.includes("application/pdf")) {
    const buffer = Buffer.from(await response.arrayBuffer());
    const parser = new PDFParse({
      data: buffer
    });
    const parsed = await parser.getText();
    await parser.destroy();
    const text = normalizeText(parsed.text);
    if (!text) {
      return null;
    }

    return {
      id: source.url,
      title: source.title ?? source.url,
      source: source.url,
      content: text,
      contentType: "pdf"
    };
  }

  const raw = await response.text();
  const html = htmlToText(raw);
  if (!html.text) {
    return null;
  }

  return {
    id: source.url,
    title: source.title ?? html.title,
    source: source.url,
    content: html.text,
    contentType: "html"
  };
}

async function loadManifest(manifestPath: string): Promise<KnowledgeSourceManifest | null> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw) as KnowledgeSourceManifest;
  } catch {
    return null;
  }
}

export async function loadKnowledgeDocuments(
  knowledgeDir: string,
  manifestPath: string
): Promise<KnowledgeDocument[]> {
  const files = await walkFiles(knowledgeDir);
  const localCandidates = files
    .filter((filePath) => SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .filter((filePath) => path.resolve(filePath) !== path.resolve(manifestPath))
    .sort();

  const documents: KnowledgeDocument[] = [];

  for (const filePath of localCandidates) {
    const document = await loadFileDocument(filePath);
    if (document) {
      documents.push(document);
    }
  }

  const manifest = await loadManifest(manifestPath);
  if (!manifest?.sources?.length) {
    return documents;
  }

  for (const source of manifest.sources) {
    try {
      if (source.type === "file" && source.path) {
        const filePath = path.isAbsolute(source.path)
          ? source.path
          : path.resolve(path.dirname(manifestPath), source.path);
        const document = await loadFileDocument(filePath, source.title);
        if (document) {
          documents.push(document);
        }
        continue;
      }

      if (source.type === "url") {
        const document = await loadRemoteDocument(source);
        if (document) {
          documents.push(document);
        }
      }
    } catch (error) {
      console.warn(`Skipping knowledge source: ${source.url ?? source.path}`, error);
    }
  }

  return documents;
}
