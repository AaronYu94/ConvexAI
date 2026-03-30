import type { BotConfig, StateStore } from "../types";
import { getConfiguredGuildIds } from "../guildConfig";
import { PostgresStateStore } from "./postgresStateStore";
import { JsonStateStore } from "./storage";

export function createStateStore(config: BotConfig): StateStore {
  const legacyGuildId = config.discordGuildId ?? getConfiguredGuildIds(config)[0];

  if (config.databaseUrl) {
    return new PostgresStateStore(config.databaseUrl, config.embeddingDimensions, legacyGuildId);
  }

  return new JsonStateStore(config.dataFile, legacyGuildId);
}
