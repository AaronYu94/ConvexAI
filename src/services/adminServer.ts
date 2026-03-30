import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import type { BotConfig, BotMessage, BotState, StateStore } from "../types";
import { KnowledgeEngine } from "./knowledgeEngine";

interface DashboardUserProfile {
  id: string;
  username: string;
  displayName: string;
  joinedAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  tags: string[];
  leadScore: number;
  messageCount: number;
  recentMessages: Array<{
    createdAt: string;
    content: string;
    channelId: string;
    source: BotMessage["source"];
  }>;
}

function clip(input: string, maxLength = 180): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}

function unauthorized(res: Response): void {
  res.setHeader("WWW-Authenticate", 'Basic realm="ConvexAI Admin"');
  res.status(401).send("需要登录后才能访问管理后台");
}

function createAuthMiddleware(config: BotConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.adminUsername || !config.adminPassword) {
      next();
      return;
    }

    const header = req.headers.authorization;
    if (!header?.startsWith("Basic ")) {
      unauthorized(res);
      return;
    }

    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    const username = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : "";
    const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

    if (username !== config.adminUsername || password !== config.adminPassword) {
      unauthorized(res);
      return;
    }

    next();
  };
}

async function listKnowledgeFiles(knowledgeDir: string): Promise<
  Array<{ path: string; sizeBytes: number; updatedAt: string }>
> {
  const output: Array<{ path: string; sizeBytes: number; updatedAt: string }> = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.name === "sources.json" || entry.name === "sources.example.json") {
        continue;
      }

      const fileStats = await stat(fullPath);
      output.push({
        path: path.relative(knowledgeDir, fullPath),
        sizeBytes: fileStats.size,
        updatedAt: fileStats.mtime.toISOString()
      });
    }
  }

  await walk(knowledgeDir);
  return output.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function readKnowledgeManifest(
  manifestPath: string
): Promise<Array<{ type: string; url?: string; path?: string; title?: string }>> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { sources?: Array<{ type: string; url?: string; path?: string; title?: string }> };
    return parsed.sources ?? [];
  } catch {
    return [];
  }
}

async function appendRemoteSource(manifestPath: string, url: string, title?: string): Promise<void> {
  const existingSources = await readKnowledgeManifest(manifestPath);
  const alreadyExists = existingSources.some((source) => source.type === "url" && source.url === url);

  if (alreadyExists) {
    return;
  }

  const nextSources = [
    ...existingSources,
    {
      type: "url",
      url,
      title: title?.trim() || undefined
    }
  ];

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        sources: nextSources
      },
      null,
      2
    ),
    "utf8"
  );
}

function buildProfiles(state: BotState): DashboardUserProfile[] {
  return Object.values(state.users)
    .map((user) => {
      const userMessages = state.messages
        .filter((message) => message.userId === user.id)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

      return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        joinedAt: user.joinedAt,
        firstSeenAt: user.firstSeenAt,
        lastSeenAt: user.lastSeenAt,
        tags: user.tags,
        leadScore: user.leadScore,
        messageCount: userMessages.length,
        recentMessages: userMessages.slice(0, 3).map((message) => ({
          createdAt: message.createdAt,
          content: clip(message.content, 200),
          channelId: message.channelId,
          source: message.source
        }))
      };
    })
    .sort((left, right) => {
      if (right.leadScore !== left.leadScore) {
        return right.leadScore - left.leadScore;
      }
      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    });
}

function buildOverview(state: BotState, knowledge: KnowledgeEngine) {
  const lastLead = state.leads.slice(-1)[0];
  const lastMessage = state.messages.slice(-1)[0];

  return {
    totalUsers: Object.keys(state.users).length,
    totalMessages: state.messages.length,
    totalLeads: state.leads.length,
    totalEvents: state.events.length,
    knowledgeChunks: knowledge.getChunkCount(),
    lastLeadAt: lastLead?.createdAt,
    lastMessageAt: lastMessage?.createdAt
  };
}

function buildRecentMessages(messages: BotMessage[]) {
  return [...messages]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 25)
    .map((message) => ({
      id: message.id,
      username: message.username,
      channelId: message.channelId,
      createdAt: message.createdAt,
      content: clip(message.content, 220),
      source: message.source
    }));
}

export class AdminServer {
  private server?: ReturnType<typeof express["application"]["listen"]>;

  constructor(
    private readonly config: BotConfig,
    private readonly store: StateStore,
    private readonly knowledge: KnowledgeEngine
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const app = express();
    const authMiddleware = createAuthMiddleware(this.config);
    const uploadDir = path.join(this.config.knowledgeDir, "uploads");
    await mkdir(uploadDir, { recursive: true });

    const storage = multer.diskStorage({
      destination: (_req, _file, callback) => {
        callback(null, uploadDir);
      },
      filename: (_req, file, callback) => {
        const safeBaseName = path
          .basename(file.originalname)
          .replace(/[^a-zA-Z0-9._-]/g, "-")
          .replace(/-+/g, "-");
        callback(null, `${Date.now()}-${safeBaseName}`);
      }
    });

    const upload = multer({
      storage,
      fileFilter: (_req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const allowed = [".md", ".txt", ".json", ".html", ".htm", ".pdf"];
        callback(null, allowed.includes(extension));
      }
    });

    app.use(express.json({ limit: "2mb" }));
    app.use("/admin", authMiddleware);

    app.get("/admin/assets/logo.png", (_req, res) => {
      res.sendFile(path.resolve(process.cwd(), "logo.png"));
    });

    app.get("/admin", async (_req, res) => {
      const htmlPath = path.resolve(process.cwd(), "admin/dashboard.html");
      res.type("html").send(await readFile(htmlPath, "utf8"));
    });

    app.get("/admin/api/dashboard", async (_req, res) => {
      const snapshot = await this.store.getSnapshot();
      const profiles = buildProfiles(snapshot);
      const localFiles = await listKnowledgeFiles(this.config.knowledgeDir);
      const manifestSources = await readKnowledgeManifest(this.config.knowledgeSourcesFile);

      res.json({
        overview: buildOverview(snapshot, this.knowledge),
        knowledge: {
          chunkSources: this.knowledge.getChunkSourceSummary(),
          localFiles,
          remoteSources: manifestSources
        },
        profiles: profiles.slice(0, 100),
        leads: [...snapshot.leads]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, 50),
        recentMessages: buildRecentMessages(snapshot.messages)
      });
    });

    app.post("/admin/api/knowledge/reload", async (_req, res) => {
      const chunkCount = await this.knowledge.reload();
      await this.store.recordEvent("admin_knowledge_reloaded", { chunkCount });
      res.json({
        ok: true,
        chunkCount
      });
    });

    app.post("/admin/api/knowledge/upload", upload.array("files", 10), async (req, res) => {
      const files = Array.isArray(req.files) ? req.files : [];
      const chunkCount = await this.knowledge.reload();
      await this.store.recordEvent("admin_knowledge_uploaded", {
        files: files.map((file) => file.filename),
        count: files.length,
        chunkCount
      });

      res.json({
        ok: true,
        uploaded: files.map((file) => ({
          filename: file.filename,
          originalName: file.originalname,
          sizeBytes: file.size
        })),
        chunkCount
      });
    });

    app.post("/admin/api/knowledge/source-url", async (req, res) => {
      const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";

      if (!url) {
        res.status(400).json({ ok: false, error: "缺少 URL" });
        return;
      }

      await appendRemoteSource(this.config.knowledgeSourcesFile, url, title);
      const chunkCount = await this.knowledge.reload();
      await this.store.recordEvent("admin_knowledge_source_added", {
        url,
        title: title || null,
        chunkCount
      });

      res.json({
        ok: true,
        chunkCount
      });
    });

    this.server = app.listen(this.config.adminPort, () => {
      console.log(`管理后台已启动：http://localhost:${this.config.adminPort}/admin`);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.server = undefined;
  }
}
