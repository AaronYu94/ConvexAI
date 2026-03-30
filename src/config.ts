import path from "node:path";
import { config as loadEnv } from "dotenv";
import type { BotConfig } from "./types";

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

export function getConfig(): BotConfig {
  return {
    discordToken: requireEnv("DISCORD_BOT_TOKEN"),
    discordClientId: requireEnv("DISCORD_CLIENT_ID"),
    discordGuildId: optionalEnv("DISCORD_GUILD_ID"),
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
    smtpPass: optionalEnv("SMTP_PASS")
  };
}
