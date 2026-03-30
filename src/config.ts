import { readFileSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import type { BotConfig, GuildChannelConfig } from "./types";

loadEnv();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseCsv(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseIntEnv(name: string, fallback: number): number {
  const value = optionalEnv(name);
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected ${name} to be an integer.`);
  }

  return parsed;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name);
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizeGuildConfig(input: Partial<GuildChannelConfig> & { guildId: string }): GuildChannelConfig {
  return {
    guildId: input.guildId.trim(),
    name: input.name?.trim() || undefined,
    welcomeChannelId: input.welcomeChannelId?.trim() || undefined,
    alertChannelId: input.alertChannelId?.trim() || undefined,
    reportChannelId: input.reportChannelId?.trim() || undefined,
    monitoredChannelIds: Array.isArray(input.monitoredChannelIds)
      ? input.monitoredChannelIds.map((channelId) => channelId.trim()).filter(Boolean)
      : []
  };
}

function parseGuildConfigs(raw: string, sourceLabel: string): GuildChannelConfig[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`${sourceLabel} must be a JSON array.`);
    }

    return parsed
      .filter((entry): entry is Partial<GuildChannelConfig> & { guildId: string } => {
        return Boolean(entry && typeof entry === "object" && typeof (entry as { guildId?: unknown }).guildId === "string");
      })
      .map(normalizeGuildConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown parse error";
    throw new Error(`Failed to parse ${sourceLabel}: ${message}`);
  }
}

function loadGuildConfigs(): { guildConfigFile?: string; guildConfigs: Record<string, GuildChannelConfig> } {
  const guildConfigFile = optionalEnv("DISCORD_GUILD_CONFIG_FILE");
  const envGuildConfigs = optionalEnv("DISCORD_GUILD_CONFIGS");
  const loadedConfigs: GuildChannelConfig[] = [];

  if (guildConfigFile) {
    const resolvedPath = path.resolve(process.cwd(), guildConfigFile);
    const fileContents = readFileSync(resolvedPath, "utf8");
    loadedConfigs.push(...parseGuildConfigs(fileContents, `DISCORD_GUILD_CONFIG_FILE (${resolvedPath})`));
  }

  if (envGuildConfigs) {
    loadedConfigs.push(...parseGuildConfigs(envGuildConfigs, "DISCORD_GUILD_CONFIGS"));
  }

  const guildConfigs: Record<string, GuildChannelConfig> = {};
  for (const guildConfig of loadedConfigs) {
    guildConfigs[guildConfig.guildId] = guildConfig;
  }

  return {
    guildConfigFile: guildConfigFile ? path.resolve(process.cwd(), guildConfigFile) : undefined,
    guildConfigs
  };
}

export function getConfig(): BotConfig {
  const { guildConfigFile, guildConfigs } = loadGuildConfigs();
  const configuredGuildIds = new Set<string>([
    ...parseCsv(optionalEnv("DISCORD_GUILD_IDS")),
    ...Object.keys(guildConfigs)
  ]);
  const legacyGuildId = optionalEnv("DISCORD_GUILD_ID");
  if (legacyGuildId) {
    configuredGuildIds.add(legacyGuildId);
  }

  return {
    discordToken: requireEnv("DISCORD_BOT_TOKEN"),
    discordClientId: requireEnv("DISCORD_CLIENT_ID"),
    discordGuildId: legacyGuildId,
    discordGuildIds: [...configuredGuildIds],
    openAiApiKey: optionalEnv("OPENAI_API_KEY"),
    openAiModel: optionalEnv("OPENAI_MODEL") ?? "gpt-4.1-mini",
    analysisModel: optionalEnv("ANALYSIS_MODEL") ?? optionalEnv("OPENAI_MODEL") ?? "gpt-4.1-mini",
    embeddingModel: optionalEnv("EMBEDDING_MODEL") ?? "text-embedding-3-small",
    embeddingDimensions: parseIntEnv("EMBEDDING_DIMENSIONS", 1536),
    databaseUrl: optionalEnv("DATABASE_URL"),
    botName: optionalEnv("BOT_NAME") ?? "Community Copilot",
    welcomeChannelId: optionalEnv("WELCOME_CHANNEL_ID"),
    alertChannelId: optionalEnv("ALERT_CHANNEL_ID"),
    reportChannelId: optionalEnv("REPORT_CHANNEL_ID"),
    monitoredChannelIds: parseCsv(optionalEnv("MONITORED_CHANNEL_IDS")),
    knowledgeDir: path.resolve(process.cwd(), optionalEnv("KNOWLEDGE_DIR") ?? "./knowledge"),
    knowledgeSourcesFile: path.resolve(process.cwd(), optionalEnv("KNOWLEDGE_SOURCES_FILE") ?? "./knowledge/sources.json"),
    dataFile: path.resolve(process.cwd(), optionalEnv("DATA_FILE") ?? "./data/state.json"),
    reportTimezone: optionalEnv("REPORT_TIMEZONE") ?? "America/New_York",
    dailyReportHour: parseIntEnv("DAILY_REPORT_HOUR", 9),
    weeklyReportDay: (optionalEnv("WEEKLY_REPORT_DAY") ?? "MON").toUpperCase(),
    weeklyReportHour: parseIntEnv("WEEKLY_REPORT_HOUR", 10),
    slackWebhookUrl: optionalEnv("SLACK_WEBHOOK_URL"),
    alertEmailTo: optionalEnv("ALERT_EMAIL_TO"),
    alertEmailFrom: optionalEnv("ALERT_EMAIL_FROM"),
    smtpHost: optionalEnv("SMTP_HOST"),
    smtpPort: parseIntEnv("SMTP_PORT", 587),
    smtpSecure: parseBoolEnv("SMTP_SECURE", false),
    smtpUser: optionalEnv("SMTP_USER"),
    smtpPass: optionalEnv("SMTP_PASS"),
    adminPort: parseIntEnv("ADMIN_PORT", 3010),
    adminUsername: optionalEnv("ADMIN_USERNAME"),
    adminPassword: optionalEnv("ADMIN_PASSWORD"),
    guildConfigFile,
    guildConfigs
  };
}
