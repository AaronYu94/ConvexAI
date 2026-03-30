import type { BotConfig, GuildChannelConfig } from "./types";

export function getConfiguredGuildIds(config: BotConfig): string[] {
  return [...new Set(config.discordGuildIds)];
}

export function getGuildConfig(config: BotConfig, guildId: string): GuildChannelConfig {
  const specific = config.guildConfigs[guildId];

  return {
    guildId,
    welcomeChannelId: specific?.welcomeChannelId ?? config.welcomeChannelId,
    alertChannelId: specific?.alertChannelId ?? config.alertChannelId,
    reportChannelId: specific?.reportChannelId ?? config.reportChannelId,
    monitoredChannelIds:
      specific?.monitoredChannelIds?.length && specific.monitoredChannelIds.length > 0
        ? specific.monitoredChannelIds
        : config.monitoredChannelIds
  };
}

export function getAllReportChannelIds(config: BotConfig): string[] {
  const ids = new Set<string>();

  if (config.reportChannelId) {
    ids.add(config.reportChannelId);
  }

  for (const guildId of getConfiguredGuildIds(config)) {
    const reportChannelId = getGuildConfig(config, guildId).reportChannelId;
    if (reportChannelId) {
      ids.add(reportChannelId);
    }
  }

  return [...ids];
}
