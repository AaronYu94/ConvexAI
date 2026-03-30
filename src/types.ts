export interface BotConfig {
  discordToken: string;
  discordClientId: string;
  discordGuildId?: string;
  openAiApiKey?: string;
  openAiModel: string;
  analysisModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  databaseUrl?: string;
  botName: string;
  welcomeChannelId?: string;
  alertChannelId?: string;
  reportChannelId?: string;
  monitoredChannelIds: string[];
  knowledgeDir: string;
  knowledgeSourcesFile: string;
  dataFile: string;
  reportTimezone: string;
  dailyReportHour: number;
  weeklyReportDay: string;
  weeklyReportHour: number;
  slackWebhookUrl?: string;
  alertEmailTo?: string;
  alertEmailFrom?: string;
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
}

export interface BotUser {
  id: string;
  username: string;
  displayName: string;
  joinedAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  tags: string[];
  leadScore: number;
}

export interface BotMessage {
  id: string;
  userId: string;
  username: string;
  channelId: string;
  content: string;
  createdAt: string;
  source: "discord";
}

export interface LeadEvent {
  id: string;
  userId: string;
  messageId: string;
  username: string;
  leadScore: number;
  reasons: string[];
  tags: string[];
  suggestedAction: string;
  createdAt: string;
}

export interface BotEvent {
  id: string;
  type: string;
  createdAt: string;
  userId?: string;
  metadata: Record<string, unknown>;
}

export interface BotState {
  users: Record<string, BotUser>;
  messages: BotMessage[];
  leads: LeadEvent[];
  events: BotEvent[];
}

export interface UserIdentityInput {
  id: string;
  username: string;
  displayName: string;
  joinedAt?: string;
}

export interface MessageInput {
  id: string;
  userId: string;
  username: string;
  channelId: string;
  content: string;
  createdAt: string;
}

export interface LeadInput {
  userId: string;
  messageId: string;
  username: string;
  leadScore: number;
  reasons: string[];
  tags: string[];
  suggestedAction: string;
}

export interface StateStore {
  init(): Promise<void>;
  getSnapshot(): Promise<BotState>;
  getUser(userId: string): Promise<BotUser | undefined>;
  upsertUser(input: UserIdentityInput): Promise<BotUser>;
  recordMessage(input: MessageInput): Promise<BotMessage>;
  updateUserSignals(userId: string, tags: string[], leadScore: number): Promise<BotUser | undefined>;
  recordLead(input: LeadInput): Promise<LeadEvent>;
  recordEvent(type: string, metadata: Record<string, unknown>, userId?: string): Promise<BotEvent>;
  close(): Promise<void>;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  source: string;
  content: string;
  contentType: "markdown" | "text" | "html" | "json" | "pdf";
}

export interface KnowledgeChunk {
  id: string;
  title: string;
  source: string;
  content: string;
  tokens: string[];
}

export interface KnowledgeSearchResult {
  chunk: KnowledgeChunk;
  score: number;
  matchedTerms: string[];
}

export interface LeadScoreResult {
  score: number;
  tags: string[];
  reasons: string[];
  shouldNotify: boolean;
  suggestedAction: string;
  summary: string;
  confidence: number;
  source: "rules" | "llm" | "hybrid";
}

export interface ModerationResult {
  shouldBlock: boolean;
  severity: "none" | "warn" | "delete";
  reason?: string;
}

export interface GeneratedAnswer {
  text: string;
  usedFallback: boolean;
}

export interface KnowledgeSourceItem {
  type: "url" | "file";
  url?: string;
  path?: string;
  title?: string;
}

export interface KnowledgeSourceManifest {
  sources: KnowledgeSourceItem[];
}
