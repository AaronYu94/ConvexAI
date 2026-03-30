import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { getConfiguredGuildIds } from "../guildConfig";
import type { BotConfig, BotEvent, BotMessage, BotState, LeadEvent, StateStore } from "../types";
import { canonicalizeLeadTags, scoreLeadIntent } from "./leadScorer";
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
    guildId: string;
    channelId: string;
    source: BotMessage["source"];
  }>;
}

interface DashboardGuildSummary {
  guildId: string;
  label: string;
  totalUsers: number;
  totalMessages: number;
  totalLeads: number;
}

function clip(input: string, maxLength = 180): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}

function deriveEngagementTags(messageCount: number): string[] {
  if (messageCount >= 20) {
    return ["core_member", "active_user"];
  }

  if (messageCount >= 5) {
    return ["active_user"];
  }

  if (messageCount >= 1) {
    return ["community_member"];
  }

  return [];
}

function countMessagesInWindow(timestamps: number[], anchorTime: number, startDaysAgo: number, endDaysAgo = 0): number {
  const start = anchorTime - startDaysAgo * 24 * 60 * 60 * 1000;
  const end = anchorTime - endDaysAgo * 24 * 60 * 60 * 1000;
  return timestamps.filter((timestamp) => timestamp > start && timestamp <= end).length;
}

function deriveLifecycleTags(userMessages: BotMessage[], baseTags: string[], guildLatestAt: number): string[] {
  if (userMessages.length === 0 || guildLatestAt === 0) {
    return [];
  }

  const timestamps = userMessages
    .map((message) => Date.parse(message.createdAt))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (timestamps.length === 0) {
    return [];
  }

  const tags = new Set<string>();
  const latestUserAt = timestamps[timestamps.length - 1];
  const previous7Days = countMessagesInWindow(timestamps, guildLatestAt, 14, 7);
  const recent7Days = countMessagesInWindow(timestamps, guildLatestAt, 7, 0);
  const recent3Days = countMessagesInWindow(timestamps, guildLatestAt, 3, 0);
  const daysSinceLastSeen = Math.floor((guildLatestAt - latestUserAt) / (24 * 60 * 60 * 1000));

  const isGoingCold =
    (previous7Days >= 3 && recent7Days <= Math.max(1, Math.floor(previous7Days * 0.4))) ||
    (userMessages.length >= 10 && daysSinceLastSeen >= 7);

  if (isGoingCold) {
    tags.add("going_cold");
    tags.add("needs_followup");
  }

  const isReadyToGrow =
    baseTags.includes("ready_to_grow") ||
    baseTags.includes("high_intent") ||
    (userMessages.length >= 5 && recent3Days >= 3 && recent7Days >= previous7Days + 2 && daysSinceLastSeen <= 3);

  if (isReadyToGrow && !tags.has("going_cold")) {
    tags.add("ready_to_grow");
  }

  return [...tags];
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

function getEventGuildId(event: BotEvent): string | undefined {
  const guildId = event.metadata.guildId;
  return typeof guildId === "string" && guildId.trim() ? guildId : undefined;
}

function filterMessagesByGuild(messages: BotMessage[], guildId?: string): BotMessage[] {
  if (!guildId) {
    return messages;
  }

  return messages.filter((message) => message.guildId === guildId);
}

function filterLeadsByGuild(leads: LeadEvent[], guildId?: string): LeadEvent[] {
  if (!guildId) {
    return leads;
  }

  return leads.filter((lead) => lead.guildId === guildId);
}

function filterEventsByGuild(events: BotEvent[], guildId?: string): BotEvent[] {
  if (!guildId) {
    return events;
  }

  return events.filter((event) => getEventGuildId(event) === guildId);
}

function buildGuildSummaries(state: BotState, config: BotConfig): DashboardGuildSummary[] {
  const configuredGuildIds = getConfiguredGuildIds(config);
  const guildIds = new Set<string>(configuredGuildIds);

  for (const message of state.messages) {
    guildIds.add(message.guildId);
  }

  for (const lead of state.leads) {
    guildIds.add(lead.guildId);
  }

  for (const event of state.events) {
    const guildId = getEventGuildId(event);
    if (guildId) {
      guildIds.add(guildId);
    }
  }

  const configuredOrder = new Map(configuredGuildIds.map((guildId, index) => [guildId, index]));

  return [...guildIds]
    .filter(Boolean)
    .map((guildId) => {
      const messages = filterMessagesByGuild(state.messages, guildId);
      const leads = filterLeadsByGuild(state.leads, guildId);
      const events = filterEventsByGuild(state.events, guildId);
      const userIds = new Set<string>();

      for (const message of messages) {
        userIds.add(message.userId);
      }

      for (const lead of leads) {
        userIds.add(lead.userId);
      }

      for (const event of events) {
        if (event.userId) {
          userIds.add(event.userId);
        }
      }

      return {
        guildId,
        label: config.guildConfigs[guildId]?.name ?? guildId,
        totalUsers: userIds.size,
        totalMessages: messages.length,
        totalLeads: leads.length
      };
    })
    .sort((left, right) => {
      const leftOrder = configuredOrder.get(left.guildId);
      const rightOrder = configuredOrder.get(right.guildId);
      if (leftOrder !== undefined && rightOrder !== undefined) {
        return leftOrder - rightOrder;
      }
      if (leftOrder !== undefined) {
        return -1;
      }
      if (rightOrder !== undefined) {
        return 1;
      }
      return left.label.localeCompare(right.label);
    });
}

function buildProfiles(state: BotState, guildId?: string): DashboardUserProfile[] {
  const messages = filterMessagesByGuild(state.messages, guildId);
  const leads = filterLeadsByGuild(state.leads, guildId);
  const events = filterEventsByGuild(state.events, guildId);
  const guildLatestAt = messages.reduce((maxTimestamp, message) => {
    const currentTimestamp = Date.parse(message.createdAt);
    return Number.isFinite(currentTimestamp) ? Math.max(maxTimestamp, currentTimestamp) : maxTimestamp;
  }, 0);
  const candidateUserIds = new Set<string>();

  for (const message of messages) {
    candidateUserIds.add(message.userId);
  }

  for (const lead of leads) {
    candidateUserIds.add(lead.userId);
  }

  for (const event of events) {
    if (event.userId) {
      candidateUserIds.add(event.userId);
    }
  }

  return [...candidateUserIds]
    .map((userId) => {
      const user = state.users[userId];
      const userMessages = messages
        .filter((message) => message.userId === userId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const userLeads = leads.filter((lead) => lead.userId === userId);
      const fallbackUsername = userMessages[0]?.username ?? userLeads[0]?.username ?? userId;
      const derivedTags = canonicalizeLeadTags(userLeads.flatMap((lead) => lead.tags));
      const derivedLeadScore = userLeads.reduce((maxScore, lead) => Math.max(maxScore, lead.leadScore), 0);
      const messageAnalyses = userMessages.map((message) => scoreLeadIntent(message.content));
      const messageLeadScore = messageAnalyses.reduce((maxScore, analysis) => Math.max(maxScore, analysis.score), 0);
      const messageDerivedTags = canonicalizeLeadTags(messageAnalyses.flatMap((analysis) => analysis.tags), messageLeadScore);
      const firstSeenAt = userMessages[userMessages.length - 1]?.createdAt ?? user?.firstSeenAt ?? new Date(0).toISOString();
      const lastSeenAt = userMessages[0]?.createdAt ?? user?.lastSeenAt ?? new Date(0).toISOString();
      const fallbackTags = canonicalizeLeadTags(user?.tags ?? [], user?.leadScore ?? 0);
      const engagementTags = deriveEngagementTags(userMessages.length);
      const contentTags = derivedTags.length > 0 ? derivedTags : messageDerivedTags.length > 0 ? messageDerivedTags : fallbackTags;
      const lifecycleTags = deriveLifecycleTags(userMessages, contentTags, guildLatestAt);
      const contentLeadScore = derivedLeadScore > 0 ? derivedLeadScore : messageLeadScore;

      return {
        id: userId,
        username: user?.username ?? fallbackUsername,
        displayName: user?.displayName ?? fallbackUsername,
        joinedAt: user?.joinedAt,
        firstSeenAt,
        lastSeenAt,
        tags: [...new Set([...contentTags, ...lifecycleTags, ...engagementTags])],
        leadScore: contentLeadScore > 0 ? contentLeadScore : user?.leadScore ?? 0,
        messageCount: userMessages.length,
        recentMessages: userMessages.slice(0, 3).map((message) => ({
          createdAt: message.createdAt,
          content: clip(message.content, 200),
          guildId: message.guildId,
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

function buildOverview(state: BotState, knowledge: KnowledgeEngine, guildId?: string) {
  const messages = filterMessagesByGuild(state.messages, guildId);
  const leads = filterLeadsByGuild(state.leads, guildId);
  const events = filterEventsByGuild(state.events, guildId);
  const userIds = new Set<string>();

  for (const message of messages) {
    userIds.add(message.userId);
  }

  for (const lead of leads) {
    userIds.add(lead.userId);
  }

  for (const event of events) {
    if (event.userId) {
      userIds.add(event.userId);
    }
  }

  const lastLead = leads.slice(-1)[0];
  const lastMessage = messages.slice(-1)[0];

  return {
    totalUsers: userIds.size,
    totalMessages: messages.length,
    totalLeads: leads.length,
    totalEvents: events.length,
    knowledgeChunks: knowledge.getChunkCount(),
    lastLeadAt: lastLead?.createdAt,
    lastMessageAt: lastMessage?.createdAt
  };
}

function buildRecentMessages(messages: BotMessage[], guildId?: string) {
  return [...filterMessagesByGuild(messages, guildId)]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 25)
    .map((message) => ({
      id: message.id,
      username: message.username,
      guildId: message.guildId,
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
      const guilds = buildGuildSummaries(snapshot, this.config);
      const requestedGuildId = typeof _req.query.guildId === "string" ? _req.query.guildId.trim() : "";
      const selectedGuildId =
        guilds.find((guild) => guild.guildId === requestedGuildId)?.guildId ?? guilds[0]?.guildId;
      const profiles = buildProfiles(snapshot, selectedGuildId);
      const localFiles = await listKnowledgeFiles(this.config.knowledgeDir);
      const manifestSources = await readKnowledgeManifest(this.config.knowledgeSourcesFile);

      res.json({
        guilds,
        selectedGuildId,
        overview: buildOverview(snapshot, this.knowledge, selectedGuildId),
        knowledge: {
          chunkSources: this.knowledge.getChunkSourceSummary(),
          localFiles,
          remoteSources: manifestSources
        },
        profiles: profiles.slice(0, 100),
        leads: [...filterLeadsByGuild(snapshot.leads, selectedGuildId)]
          .map((lead) => ({
            ...lead,
            tags: canonicalizeLeadTags(lead.tags, lead.leadScore)
          }))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, 50),
        recentMessages: buildRecentMessages(snapshot.messages, selectedGuildId)
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
