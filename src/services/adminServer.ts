import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChannelType, Client, TextChannel } from "discord.js";
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

interface DashboardAnswerHandoff {
  id: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
  username: string;
  displayName: string;
  question: string;
  reason: string;
  draftAnswer: string;
  createdAt: string;
  source: string;
}

interface DashboardAnswerReview {
  id: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
  username: string;
  displayName: string;
  question: string;
  answer: string;
  createdAt: string;
  source: string;
  usedFallback: boolean;
  resultCount: number;
  sampleReason: string;
}

interface ActivityRuleConfig {
  guildId: string;
  name: string;
  allowedChannelIds: string[];
  includeKeywords: string[];
  excludeKeywords: string[];
  requiredTags: string[];
  minMessageCount: number;
}

interface DashboardActivitySubmission {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  username: string;
  displayName: string;
  createdAt: string;
  content: string;
  tags: string[];
  messageCount: number;
  status: "shortlisted" | "needs_review" | "approved" | "rejected";
  screeningSummary: string;
  reviewNote?: string;
}

interface DashboardOpsCandidate {
  userId: string;
  username: string;
  displayName: string;
  primaryTag?: string;
  rationale: string;
  matchingSnippet?: string;
  lastSeenAt: string;
}

interface DashboardOpsPreview {
  mode: "recommend" | "send_message";
  instruction: string;
  summary: string;
  draftedMessage?: string;
  canExecute: boolean;
  candidates: DashboardOpsCandidate[];
}

interface ParsedOpsInstruction {
  mode: "recommend" | "send_message";
  tags: string[];
  keywords: string[];
  timeWindow: "today" | "yesterday" | "last_7_days" | "last_30_days" | "all_time";
  draftedMessage?: string;
}

interface RankedOpsCandidate extends DashboardOpsCandidate {
  score: number;
}

const DEFAULT_ACTIVITY_RULE_NAME = "默认活动筛选";
const DEFAULT_ACTIVITY_RULE: Omit<ActivityRuleConfig, "guildId"> = {
  name: DEFAULT_ACTIVITY_RULE_NAME,
  allowedChannelIds: [],
  includeKeywords: [],
  excludeKeywords: [],
  requiredTags: [],
  minMessageCount: 0
};

const TASK_TAG_PATTERNS: Array<{ tag: string; patterns: RegExp[] }> = [
  {
    tag: "high_intent",
    patterns: [/高意向/u, /high intent/i]
  },
  {
    tag: "going_cold",
    patterns: [/变冷中/u, /going cold/i, /流失风险/u]
  },
  {
    tag: "ready_to_grow",
    patterns: [/准备成长/u, /准备接入/u, /ready to grow/i]
  },
  {
    tag: "needs_followup",
    patterns: [/需要跟进/u, /follow-?up/i]
  },
  {
    tag: "needs_your_call",
    patterns: [/需要你拍板/u, /人工复核/u, /needs your call/i]
  },
  {
    tag: "event_candidate",
    patterns: [/活动候选/u, /event candidate/i, /报名/u, /参赛/u]
  },
  {
    tag: "support_issue",
    patterns: [/支持问题/u, /support issue/i, /报错/u, /异常/u]
  },
  {
    tag: "community_feedback",
    patterns: [/社区反馈/u, /feedback/i, /建议/u]
  },
  {
    tag: "core_member",
    patterns: [/核心成员/u, /core member/i]
  },
  {
    tag: "active_user",
    patterns: [/活跃用户/u, /active user/i]
  }
];

const PRIMARY_TAG_PRIORITY = [
  "high_intent",
  "going_cold",
  "ready_to_grow",
  "needs_your_call",
  "event_candidate",
  "needs_followup",
  "core_member",
  "active_user",
  "community_feedback",
  "support_issue",
  "community_member"
];

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

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeSearchable(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeActivityRule(guildId: string, input?: Partial<ActivityRuleConfig>): ActivityRuleConfig {
  return {
    guildId,
    name: input?.name?.trim() || DEFAULT_ACTIVITY_RULE_NAME,
    allowedChannelIds: normalizeStringList(input?.allowedChannelIds),
    includeKeywords: normalizeStringList(input?.includeKeywords).map(normalizeSearchable),
    excludeKeywords: normalizeStringList(input?.excludeKeywords).map(normalizeSearchable),
    requiredTags: normalizeStringList(input?.requiredTags),
    minMessageCount: Math.max(0, Number(input?.minMessageCount ?? 0) || 0)
  };
}

async function readActivityRules(filePath: string): Promise<Record<string, ActivityRuleConfig>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { guilds?: Record<string, Partial<ActivityRuleConfig>> };
    const nextRules: Record<string, ActivityRuleConfig> = {};
    for (const [guildId, rule] of Object.entries(parsed.guilds ?? {})) {
      nextRules[guildId] = normalizeActivityRule(guildId, rule);
    }
    return nextRules;
  } catch {
    return {};
  }
}

async function writeActivityRules(filePath: string, rules: Record<string, ActivityRuleConfig>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify(
      {
        guilds: rules
      },
      null,
      2
    ),
    "utf8"
  );
}

function pickPrimaryTag(tags: string[]): string | undefined {
  return PRIMARY_TAG_PRIORITY.find((tag) => tags.includes(tag)) ?? tags[0];
}

function countMessagesForTimeWindow(messages: BotMessage[], timeWindow: ParsedOpsInstruction["timeWindow"], now = new Date()): BotMessage[] {
  if (timeWindow === "all_time") {
    return messages;
  }

  const start = new Date(now);
  start.setSeconds(0, 0);

  if (timeWindow === "today") {
    start.setHours(0, 0, 0, 0);
  } else if (timeWindow === "yesterday") {
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 1);
  } else if (timeWindow === "last_7_days") {
    start.setDate(start.getDate() - 7);
  } else if (timeWindow === "last_30_days") {
    start.setDate(start.getDate() - 30);
  }

  const end = new Date(now);
  if (timeWindow === "yesterday") {
    end.setHours(0, 0, 0, 0);
  }

  const startMs = start.getTime();
  const endMs = end.getTime();
  return messages.filter((message) => {
    const timestamp = Date.parse(message.createdAt);
    return Number.isFinite(timestamp) && timestamp >= startMs && timestamp <= endMs;
  });
}

function extractQuotedSegments(input: string): string[] {
  const matches = [...input.matchAll(/["“'‘]([^"”'’]{2,80})["”'’]/g)];
  return normalizeStringList(matches.map((match) => match[1]));
}

function extractKeywords(input: string): string[] {
  const quoted = extractQuotedSegments(input);
  if (quoted.length > 0) {
    return quoted.map(normalizeSearchable);
  }

  const patterns = [
    /(?:问过|问到|提到|关于)\s*([^，。,.]{1,40}?)(?:的人|的用户|的成员|今天|本周|最近|并|，|。|$)/u,
    /(?:asked about|about)\s+([^,.]{1,40}?)(?:\s+today|\s+this week|\s+recently|,|\.|$)/i
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    const value = match?.[1]?.trim();
    if (value) {
      return normalizeStringList(
        value
          .split(/[、/]| and | 或 /i)
          .map((item) => item.trim())
          .filter(Boolean)
      ).map(normalizeSearchable);
    }
  }

  return [];
}

function extractDraftedMessage(input: string): string | undefined {
  const patterns = [
    /(?:告诉他们|让他们知道|通知他们|并说明|并告诉他们|并说)\s*(.+)$/u,
    /(?:let them know|tell them|message them that|notify them that)\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    const value = match?.[1]?.trim();
    if (value) {
      return value.replace(/[。.]$/, "").trim();
    }
  }

  return undefined;
}

function parseOpsInstruction(instruction: string): ParsedOpsInstruction {
  const normalized = instruction.trim();
  const lower = normalized.toLowerCase();
  const tags = TASK_TAG_PATTERNS
    .filter((entry) => entry.patterns.some((pattern) => pattern.test(normalized)))
    .map((entry) => entry.tag);
  const keywords = extractKeywords(normalized);
  const draftedMessage = extractDraftedMessage(normalized);
  const mode =
    /发送|发给|私信|通知|告诉他们|follow-?up|message them|notify them|send\b/i.test(normalized) && draftedMessage
      ? "send_message"
      : "recommend";

  let timeWindow: ParsedOpsInstruction["timeWindow"] = "all_time";
  if (/今天|today/i.test(normalized)) {
    timeWindow = "today";
  } else if (/昨天|yesterday/i.test(normalized)) {
    timeWindow = "yesterday";
  } else if (/本周|this week/i.test(normalized)) {
    timeWindow = "last_7_days";
  } else if (/最近 ?30 ?天|last 30 days/i.test(normalized)) {
    timeWindow = "last_30_days";
  } else if (/最近|过去 ?7 ?天|last 7 days/i.test(normalized)) {
    timeWindow = "last_7_days";
  }

  return {
    mode,
    tags,
    keywords,
    timeWindow,
    draftedMessage
  };
}

function scoreRecommendationFit(profile: DashboardUserProfile): number {
  let score = profile.leadScore;
  if (profile.tags.includes("high_intent")) {
    score += 35;
  }
  if (profile.tags.includes("ready_to_grow")) {
    score += 22;
  }
  if (profile.tags.includes("going_cold")) {
    score += 18;
  }
  if (profile.tags.includes("core_member")) {
    score += 14;
  }
  if (profile.tags.includes("active_user")) {
    score += 8;
  }
  if (profile.tags.includes("support_issue")) {
    score -= 12;
  }
  if (profile.tags.includes("spam_risk")) {
    score -= 80;
  }
  return score;
}

function buildCandidateReason(
  profile: DashboardUserProfile,
  matchedMessages: BotMessage[],
  primaryTag: string | undefined,
  parsed: ParsedOpsInstruction
): string {
  const parts: string[] = [];
  if (profile.messageCount > 0) {
    parts.push(`累计 ${profile.messageCount} 条消息`);
  }
  if (primaryTag === "high_intent") {
    parts.push("当前属于高意向窗口，适合优先推进");
  } else if (primaryTag === "going_cold") {
    parts.push("最近活跃度在下降，适合尽快 nudging");
  } else if (primaryTag === "ready_to_grow") {
    parts.push("最近参与和兴趣在升温，适合继续推进");
  } else if (primaryTag === "needs_your_call") {
    parts.push("近期出现需要人工判断的问题");
  } else if (primaryTag === "event_candidate") {
    parts.push("近期出现活动报名或提交信号");
  }

  if (matchedMessages.length > 0) {
    const latest = matchedMessages[0];
    const keywordText = parsed.keywords.length > 0 ? `最近提到 ${parsed.keywords.map((keyword) => `“${keyword}”`).join(" / ")}` : "最近有命中消息";
    parts.push(`${keywordText}，最新一条是：${clip(latest.content, 72)}`);
  }

  return parts.join("；");
}

function buildOpsPreview(
  instruction: string,
  profiles: DashboardUserProfile[],
  messages: BotMessage[]
): DashboardOpsPreview {
  const parsed = parseOpsInstruction(instruction);
  const scopedMessages = countMessagesForTimeWindow(messages, parsed.timeWindow)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const rawCandidates: RankedOpsCandidate[] = [];
  for (const profile of profiles) {
      const matchedMessages = scopedMessages.filter((message) => {
        if (message.userId !== profile.id) {
          return false;
        }
        if (parsed.keywords.length === 0) {
          return true;
        }
        const normalizedContent = normalizeSearchable(message.content);
        return parsed.keywords.some((keyword) => normalizedContent.includes(keyword));
      });

      if (parsed.tags.length > 0 && !parsed.tags.every((tag) => profile.tags.includes(tag))) {
        continue;
      }

      if (parsed.keywords.length > 0 && matchedMessages.length === 0) {
        continue;
      }

      if (parsed.tags.length === 0 && parsed.keywords.length === 0) {
        const defaultEligible =
          profile.tags.includes("high_intent") ||
          profile.tags.includes("ready_to_grow") ||
          profile.tags.includes("going_cold") ||
          profile.tags.includes("event_candidate") ||
          profile.tags.includes("core_member");
        if (!defaultEligible || profile.tags.includes("spam_risk")) {
          continue;
        }
      }

      const primaryTag = pickPrimaryTag(profile.tags);
      rawCandidates.push({
        userId: profile.id,
        username: profile.username,
        displayName: profile.displayName,
        primaryTag,
        rationale: buildCandidateReason(profile, matchedMessages, primaryTag, parsed),
        matchingSnippet: matchedMessages[0] ? clip(matchedMessages[0].content, 120) : undefined,
        lastSeenAt: profile.lastSeenAt,
        score: scoreRecommendationFit(profile)
      });
    }

  const candidates = rawCandidates
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    })
    .slice(0, parsed.mode === "send_message" ? 25 : 12)
    .map(({ score: _score, ...candidate }) => candidate);

  const summary =
    candidates.length === 0
      ? "我还没筛到合适的人群。可以在指令里补充更具体的标签、主题词或时间范围。"
      : parsed.mode === "send_message"
        ? `已识别 ${candidates.length} 位可触达成员，默认会通过 Discord 私信发送。`
        : `已为你筛出 ${candidates.length} 位优先人选，可直接用于邀请、提醒或人工跟进。`;

  return {
    mode: parsed.mode,
    instruction,
    summary,
    draftedMessage: parsed.draftedMessage,
    canExecute: parsed.mode === "send_message" && Boolean(parsed.draftedMessage) && candidates.length > 0,
    candidates
  };
}

function buildActivitySubmissions(
  messages: BotMessage[],
  profiles: DashboardUserProfile[],
  events: BotEvent[],
  guildId: string,
  rule: ActivityRuleConfig
): DashboardActivitySubmission[] {
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
  const decisions = new Map<string, { verdict: "approved" | "rejected"; note?: string }>();

  for (const event of events) {
    if (event.type !== "activity_submission_reviewed") {
      continue;
    }
    const submissionId = typeof event.metadata.submissionId === "string" ? event.metadata.submissionId : "";
    const verdict = event.metadata.verdict === "approved" ? "approved" : event.metadata.verdict === "rejected" ? "rejected" : undefined;
    if (!submissionId || !verdict) {
      continue;
    }
    decisions.set(submissionId, {
      verdict,
      note: typeof event.metadata.note === "string" ? event.metadata.note : undefined
    });
  }

  return messages
    .filter((message) => message.guildId === guildId)
    .filter((message) => scoreLeadIntent(message.content).tags.includes("event_candidate"))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 80)
    .map((message) => {
      const profile = profileMap.get(message.userId);
      const normalizedContent = normalizeSearchable(message.content);
      const matchedKeywords = rule.includeKeywords.filter((keyword) => normalizedContent.includes(keyword));
      const blockedKeywords = rule.excludeKeywords.filter((keyword) => normalizedContent.includes(keyword));
      const missingTags = rule.requiredTags.filter((tag) => !(profile?.tags ?? []).includes(tag));
      const allowedChannel = rule.allowedChannelIds.length === 0 || rule.allowedChannelIds.includes(message.channelId);
      const enoughMessages = (profile?.messageCount ?? 0) >= rule.minMessageCount;
      const keywordMatched = rule.includeKeywords.length === 0 || matchedKeywords.length > 0;
      const noBlockedTerms = blockedKeywords.length === 0;
      const tagMatched = missingTags.length === 0;

      const screeningParts = [
        keywordMatched
          ? rule.includeKeywords.length > 0
            ? `命中关键词：${matchedKeywords.join(" / ")}`
            : "未设置必需关键词"
          : "未命中必需关键词",
        noBlockedTerms ? "未命中排除词" : `命中排除词：${blockedKeywords.join(" / ")}`,
        allowedChannel ? "频道通过" : "不在允许的活动频道",
        enoughMessages ? `消息数通过（${profile?.messageCount ?? 0}）` : `消息数不足（至少 ${rule.minMessageCount} 条）`,
        tagMatched ? "标签通过" : `缺少标签：${missingTags.join(" / ")}`
      ];

      const decision = decisions.get(message.id);
      const status =
        decision?.verdict ?? (keywordMatched && noBlockedTerms && allowedChannel && enoughMessages && tagMatched ? "shortlisted" : "needs_review");

      return {
        id: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.userId,
        username: profile?.username ?? message.username,
        displayName: profile?.displayName ?? message.username,
        createdAt: message.createdAt,
        content: message.content,
        tags: canonicalizeLeadTags(scoreLeadIntent(message.content).tags),
        messageCount: profile?.messageCount ?? 0,
        status,
        screeningSummary: screeningParts.join("；"),
        reviewNote: decision?.note
      };
    });
}

function buildAnswerHandoffs(events: BotEvent[], guildId?: string): DashboardAnswerHandoff[] {
  const requests = new Map<string, DashboardAnswerHandoff>();
  const closedIds = new Set<string>();

  for (const event of events) {
    if (event.type === "answer_handoff_resolved" || event.type === "answer_handoff_dismissed") {
      const handoffId = typeof event.metadata.handoffId === "string" ? event.metadata.handoffId : undefined;
      if (handoffId) {
        closedIds.add(handoffId);
      }
      continue;
    }

    if (event.type !== "answer_handoff_requested") {
      continue;
    }

    const eventGuildId = getEventGuildId(event);
    if (guildId && eventGuildId !== guildId) {
      continue;
    }

    requests.set(event.id, {
      id: event.id,
      guildId: eventGuildId,
      channelId: typeof event.metadata.channelId === "string" ? event.metadata.channelId : undefined,
      userId: event.userId,
      username:
        typeof event.metadata.username === "string"
          ? event.metadata.username
          : typeof event.metadata.displayName === "string"
            ? event.metadata.displayName
            : event.userId ?? "unknown",
      displayName:
        typeof event.metadata.displayName === "string"
          ? event.metadata.displayName
          : typeof event.metadata.username === "string"
            ? event.metadata.username
            : event.userId ?? "unknown",
      question: typeof event.metadata.question === "string" ? event.metadata.question : "",
      reason: typeof event.metadata.reason === "string" ? event.metadata.reason : "Manual review requested.",
      draftAnswer: typeof event.metadata.draftAnswer === "string" ? event.metadata.draftAnswer : "",
      createdAt: event.createdAt,
      source: typeof event.metadata.source === "string" ? event.metadata.source : "discord_message"
    });
  }

  return [...requests.values()]
    .filter((handoff) => !closedIds.has(handoff.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function appendReviewedAnswerMemory(
  knowledgeDir: string,
  handoff: DashboardAnswerHandoff,
  answer: string
): Promise<string> {
  const filePath = path.join(knowledgeDir, "review-memory.md");
  const block = [
    "",
    `## Human-reviewed answer ${new Date().toISOString()}`,
    "",
    `- User: ${handoff.displayName} (@${handoff.username})`,
    `- Guild: ${handoff.guildId ?? "unknown"}`,
    `- Channel: ${handoff.channelId ?? "unknown"}`,
    `- Source: ${handoff.source}`,
    "",
    "### Question",
    handoff.question.trim(),
    "",
    "### Approved Answer",
    answer.trim(),
    ""
  ].join("\n");

  await appendFile(filePath, block, "utf8");
  return filePath;
}

function hashSampleSeed(input: string): number {
  let hash = 0;
  for (const char of input) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function getAnswerReviewSampleReason(metadata: Record<string, unknown>): string | null {
  const usedFallback = Boolean(metadata.usedFallback);
  const resultCount = typeof metadata.resultCount === "number" ? metadata.resultCount : 0;
  if (usedFallback) {
    return "这条回答走了 fallback，适合优先人工抽检。";
  }

  if (resultCount <= 1) {
    return "这条回答命中的知识上下文较少，建议人工抽样复核。";
  }

  const seed = `${String(metadata.question ?? "")}:${String(metadata.createdAt ?? "")}`;
  return hashSampleSeed(seed) % 4 === 0 ? "系统定期抽样复核这类已发送回答。" : null;
}

function buildAnswerReviews(events: BotEvent[], guildId?: string): DashboardAnswerReview[] {
  const answers = new Map<string, DashboardAnswerReview>();
  const reviewedIds = new Set<string>();

  for (const event of events) {
    if (event.type === "answer_review_logged") {
      const answerEventId = typeof event.metadata.answerEventId === "string" ? event.metadata.answerEventId : undefined;
      if (answerEventId) {
        reviewedIds.add(answerEventId);
      }
      continue;
    }

    if (event.type !== "message_answer_sent" && event.type !== "slash_answer_sent") {
      continue;
    }

    const eventGuildId = getEventGuildId(event);
    if (guildId && eventGuildId !== guildId) {
      continue;
    }

    const sampleReason = getAnswerReviewSampleReason({
      ...event.metadata,
      createdAt: event.createdAt
    });
    if (!sampleReason) {
      continue;
    }

    answers.set(event.id, {
      id: event.id,
      guildId: eventGuildId,
      channelId: typeof event.metadata.channelId === "string" ? event.metadata.channelId : undefined,
      userId: event.userId,
      username:
        typeof event.metadata.username === "string"
          ? event.metadata.username
          : typeof event.metadata.displayName === "string"
            ? event.metadata.displayName
            : event.userId ?? "unknown",
      displayName:
        typeof event.metadata.displayName === "string"
          ? event.metadata.displayName
          : typeof event.metadata.username === "string"
            ? event.metadata.username
            : event.userId ?? "unknown",
      question: typeof event.metadata.question === "string" ? event.metadata.question : "",
      answer: typeof event.metadata.answer === "string" ? event.metadata.answer : "",
      createdAt: event.createdAt,
      source: typeof event.metadata.source === "string" ? event.metadata.source : "discord_message",
      usedFallback: Boolean(event.metadata.usedFallback),
      resultCount: typeof event.metadata.resultCount === "number" ? event.metadata.resultCount : 0,
      sampleReason
    });
  }

  return [...answers.values()]
    .filter((review) => !reviewedIds.has(review.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
  private discordClient?: Client;

  constructor(
    private readonly config: BotConfig,
    private readonly store: StateStore,
    private readonly knowledge: KnowledgeEngine
  ) {}

  attachClient(client: Client): void {
    this.discordClient = client;
  }

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
      const activityRules = await readActivityRules(this.config.activityRulesFile);
      const guilds = buildGuildSummaries(snapshot, this.config);
      const requestedGuildId = typeof _req.query.guildId === "string" ? _req.query.guildId.trim() : "";
      const selectedGuildId =
        guilds.find((guild) => guild.guildId === requestedGuildId)?.guildId ?? guilds[0]?.guildId;
      const profiles = buildProfiles(snapshot, selectedGuildId);
      const activityRule = normalizeActivityRule(selectedGuildId ?? "default", activityRules[selectedGuildId ?? "default"]);
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
        activity: selectedGuildId
          ? {
              rule: activityRule,
              submissions: buildActivitySubmissions(
                snapshot.messages,
                profiles,
                filterEventsByGuild(snapshot.events, selectedGuildId),
                selectedGuildId,
                activityRule
              )
            }
          : {
              rule: activityRule,
              submissions: []
            },
        handoffs: buildAnswerHandoffs(snapshot.events, selectedGuildId).slice(0, 50),
        reviews: buildAnswerReviews(snapshot.events, selectedGuildId).slice(0, 50),
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

    app.post("/admin/api/activity/rule", async (req, res) => {
      const guildId = typeof req.body?.guildId === "string" ? req.body.guildId.trim() : "";
      if (!guildId) {
        res.status(400).json({ error: "缺少 guildId。" });
        return;
      }

      const rules = await readActivityRules(this.config.activityRulesFile);
      const nextRule = normalizeActivityRule(guildId, {
        name: typeof req.body?.name === "string" ? req.body.name : DEFAULT_ACTIVITY_RULE_NAME,
        allowedChannelIds: Array.isArray(req.body?.allowedChannelIds) ? req.body.allowedChannelIds : [],
        includeKeywords: Array.isArray(req.body?.includeKeywords) ? req.body.includeKeywords : [],
        excludeKeywords: Array.isArray(req.body?.excludeKeywords) ? req.body.excludeKeywords : [],
        requiredTags: Array.isArray(req.body?.requiredTags) ? req.body.requiredTags : [],
        minMessageCount: Number(req.body?.minMessageCount ?? 0)
      });
      rules[guildId] = nextRule;
      await writeActivityRules(this.config.activityRulesFile, rules);
      await this.store.recordEvent("activity_rule_updated", {
        guildId,
        rule: nextRule
      });

      res.json({
        ok: true,
        rule: nextRule
      });
    });

    app.post("/admin/api/activity/submissions/:id/review", async (req, res) => {
      const submissionId = req.params.id;
      const guildId = typeof req.body?.guildId === "string" ? req.body.guildId.trim() : "";
      const verdict = req.body?.verdict === "approved" ? "approved" : req.body?.verdict === "rejected" ? "rejected" : "";
      const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";

      if (!guildId || !verdict) {
        res.status(400).json({ error: "缺少 guildId 或 verdict。" });
        return;
      }

      await this.store.recordEvent("activity_submission_reviewed", {
        submissionId,
        guildId,
        verdict,
        note: note || null
      });

      res.json({
        ok: true,
        submissionId,
        verdict
      });
    });

    app.post("/admin/api/ops/preview", async (req, res) => {
      const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";
      const guildId = typeof req.body?.guildId === "string" ? req.body.guildId.trim() : "";
      if (!instruction || !guildId) {
        res.status(400).json({ error: "缺少指令或服务器 ID。" });
        return;
      }

      const snapshot = await this.store.getSnapshot();
      const profiles = buildProfiles(snapshot, guildId);
      const preview = buildOpsPreview(instruction, profiles, filterMessagesByGuild(snapshot.messages, guildId));
      await this.store.recordEvent("ops_preview_requested", {
        guildId,
        instruction,
        mode: preview.mode,
        candidateCount: preview.candidates.length
      });
      res.json({
        ok: true,
        preview
      });
    });

    app.post("/admin/api/ops/execute", async (req, res) => {
      const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";
      const guildId = typeof req.body?.guildId === "string" ? req.body.guildId.trim() : "";
      if (!instruction || !guildId) {
        res.status(400).json({ error: "缺少指令或服务器 ID。" });
        return;
      }

      const snapshot = await this.store.getSnapshot();
      const profiles = buildProfiles(snapshot, guildId);
      const preview = buildOpsPreview(instruction, profiles, filterMessagesByGuild(snapshot.messages, guildId));

      if (!preview.canExecute || preview.mode !== "send_message" || !preview.draftedMessage) {
        res.status(400).json({ error: "这条任务目前只能预览，不能直接执行。请补充明确的人群和发送内容。" });
        return;
      }

      if (!this.discordClient) {
        res.status(503).json({ error: "Discord 客户端尚未就绪，暂时无法执行批量触达。" });
        return;
      }

      const deliveries: Array<{ userId: string; username: string; status: "sent" | "failed"; error?: string }> = [];
      for (const candidate of preview.candidates) {
        try {
          const user = await this.discordClient.users.fetch(candidate.userId);
          await user.send(preview.draftedMessage);
          deliveries.push({
            userId: candidate.userId,
            username: candidate.username,
            status: "sent"
          });
        } catch (error) {
          deliveries.push({
            userId: candidate.userId,
            username: candidate.username,
            status: "failed",
            error: error instanceof Error ? error.message : "Unknown error"
          });
        }
      }

      await this.store.recordEvent("ops_task_executed", {
        guildId,
        instruction,
        mode: preview.mode,
        message: preview.draftedMessage,
        attemptedCount: deliveries.length,
        sentCount: deliveries.filter((item) => item.status === "sent").length,
        failedCount: deliveries.filter((item) => item.status === "failed").length,
        deliveries
      });

      res.json({
        ok: true,
        preview,
        deliveries
      });
    });

    app.post("/admin/api/handoffs/:id/resolve", async (req, res) => {
      const snapshot = await this.store.getSnapshot();
      const handoff = buildAnswerHandoffs(snapshot.events).find((item) => item.id === req.params.id);
      if (!handoff) {
        res.status(404).json({ error: "未找到待处理的人工接管项。" });
        return;
      }

      const answer = typeof req.body?.answer === "string" ? req.body.answer.trim() : "";
      const addToKnowledge = req.body?.addToKnowledge !== false;
      const sendToDiscord = req.body?.sendToDiscord !== false;
      if (!answer) {
        res.status(400).json({ error: "请填写人工确认后的答案。" });
        return;
      }

      let memoryFile: string | undefined;
      if (addToKnowledge) {
        memoryFile = await appendReviewedAnswerMemory(this.config.knowledgeDir, handoff, answer);
        await this.knowledge.reload();
      }

      let postedToDiscord = false;
      if (sendToDiscord && this.discordClient && handoff.channelId) {
        const channel = await this.discordClient.channels.fetch(handoff.channelId).catch(() => null);
        if (channel && channel.type === ChannelType.GuildText) {
          const prefix = handoff.userId ? `<@${handoff.userId}> ` : "";
          const message = `${prefix}人工补充回复：\n${answer}`.slice(0, 1900);
          await (channel as TextChannel).send(message);
          postedToDiscord = true;
        }
      }

      await this.store.recordEvent(
        "answer_handoff_resolved",
        {
          handoffId: handoff.id,
          guildId: handoff.guildId,
          channelId: handoff.channelId,
          question: handoff.question,
          answer,
          addToKnowledge,
          memoryFile,
          sendToDiscord,
          postedToDiscord
        },
        handoff.userId
      );

      res.json({
        ok: true,
        addToKnowledge,
        memoryFile,
        sendToDiscord,
        postedToDiscord
      });
    });

    app.post("/admin/api/handoffs/:id/dismiss", async (req, res) => {
      const snapshot = await this.store.getSnapshot();
      const handoff = buildAnswerHandoffs(snapshot.events).find((item) => item.id === req.params.id);
      if (!handoff) {
        res.status(404).json({ error: "未找到待处理的人工接管项。" });
        return;
      }

      const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
      await this.store.recordEvent(
        "answer_handoff_dismissed",
        {
          handoffId: handoff.id,
          guildId: handoff.guildId,
          channelId: handoff.channelId,
          note
        },
        handoff.userId
      );

      res.json({ ok: true });
    });

    app.post("/admin/api/reviews/:id", async (req, res) => {
      const snapshot = await this.store.getSnapshot();
      const review = buildAnswerReviews(snapshot.events).find((item) => item.id === req.params.id);
      if (!review) {
        res.status(404).json({ error: "未找到待复核的回答。" });
        return;
      }

      const verdict = typeof req.body?.verdict === "string" ? req.body.verdict.trim() : "";
      const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
      const correctedAnswer = typeof req.body?.correctedAnswer === "string" ? req.body.correctedAnswer.trim() : "";
      const addToKnowledge = req.body?.addToKnowledge === true;

      if (!verdict) {
        res.status(400).json({ error: "请先选择复核结论。" });
        return;
      }

      let memoryFile: string | undefined;
      if (addToKnowledge && correctedAnswer) {
        memoryFile = await appendReviewedAnswerMemory(
          this.config.knowledgeDir,
          {
            id: review.id,
            guildId: review.guildId,
            channelId: review.channelId,
            userId: review.userId,
            username: review.username,
            displayName: review.displayName,
            question: review.question,
            reason: review.sampleReason,
            draftAnswer: review.answer,
            createdAt: review.createdAt,
            source: review.source
          },
          correctedAnswer
        );
        await this.knowledge.reload();
      }

      await this.store.recordEvent(
        "answer_review_logged",
        {
          answerEventId: review.id,
          guildId: review.guildId,
          channelId: review.channelId,
          verdict,
          note,
          correctedAnswer: correctedAnswer || null,
          addToKnowledge,
          memoryFile
        },
        review.userId
      );

      res.json({
        ok: true,
        verdict,
        addToKnowledge,
        memoryFile
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
