import type { BotConfig, StateStore } from "../types";
import { PostgresStateStore } from "./postgresStateStore";
import { JsonStateStore } from "./storage";

export function createStateStore(config: BotConfig): StateStore {
  if (config.databaseUrl) {
    return new PostgresStateStore(config.databaseUrl, config.embeddingDimensions);
  }

  return new JsonStateStore(config.dataFile);
}
