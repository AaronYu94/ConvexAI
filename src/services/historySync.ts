import {
  ChannelType,
  Client,
  Collection,
  Guild,
  Message,
  type TextBasedChannel
} from "discord.js";
import { getConfiguredGuildIds } from "../guildConfig";
import { scoreLeadIntent } from "./leadScorer";
import type { BotConfig, StateStore } from "../types";

interface GuildHistorySyncSummary {
  guildId: string;
  guildName: string;
  channelCount: number;
  messageCount: number;
  skippedBotMessages: number;
  skippedEmptyMessages: number;
}

type SyncableChannel = TextBasedChannel & {
  id: string;
  name?: string;
};

function isSyncableChannel(channel: unknown): channel is SyncableChannel {
  if (!channel || typeof channel !== "object") {
    return false;
  }

  const candidate = channel as { type?: ChannelType; messages?: unknown };
  return [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(candidate.type as ChannelType) && Boolean(candidate.messages);
}

function extractMessageText(message: Message): string {
  const parts: string[] = [];
  const content = message.content.replace(/\s+/g, " ").trim();
  if (content) {
    parts.push(content);
  }

  const attachmentSummary = [...message.attachments.values()]
    .map((attachment) => attachment.name || attachment.url)
    .filter(Boolean);
  if (attachmentSummary.length > 0) {
    parts.push(`[附件] ${attachmentSummary.join(", ")}`);
  }

  return parts.join("\n").trim();
}

async function syncChannelHistory(
  guild: Guild,
  channel: SyncableChannel,
  store: StateStore
): Promise<{ messageCount: number; skippedBotMessages: number; skippedEmptyMessages: number }> {
  let before: string | undefined;
  let messageCount = 0;
  let skippedBotMessages = 0;
  let skippedEmptyMessages = 0;

  while (true) {
    const batch: Collection<string, Message> = await channel.messages.fetch({
      limit: 100,
      before,
      cache: false
    });

    if (batch.size === 0) {
      break;
    }

    const chronologicalMessages = [...batch.values()].sort((left, right) => left.createdTimestamp - right.createdTimestamp);

    for (const message of chronologicalMessages) {
      if (message.author.bot) {
        skippedBotMessages += 1;
        continue;
      }

      const content = extractMessageText(message);
      if (!content) {
        skippedEmptyMessages += 1;
        continue;
      }

      await store.upsertUser({
        id: message.author.id,
        username: message.author.username,
        displayName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
        joinedAt: message.member?.joinedAt?.toISOString()
      });

      await store.recordMessage({
        id: message.id,
        userId: message.author.id,
        username: message.author.username,
        guildId: guild.id,
        channelId: message.channelId,
        content,
        createdAt: message.createdAt.toISOString(),
        source: "discord_message"
      });

      const analysis = scoreLeadIntent(content);
      if (analysis.tags.length > 0) {
        await store.updateUserSignals(message.author.id, analysis.tags, analysis.score);
      }

      messageCount += 1;
    }

    before = batch.last()?.id;

    if (batch.size < 100) {
      break;
    }
  }

  return {
    messageCount,
    skippedBotMessages,
    skippedEmptyMessages
  };
}

export async function syncHistoricalMessages(
  client: Client,
  config: BotConfig,
  store: StateStore
): Promise<GuildHistorySyncSummary[]> {
  const configuredGuildIds = getConfiguredGuildIds(config);
  const guildRefs =
    configuredGuildIds.length > 0
      ? await Promise.all(configuredGuildIds.map((guildId) => client.guilds.fetch(guildId)))
      : [...(await client.guilds.fetch()).values()];

  const summaries: GuildHistorySyncSummary[] = [];

  for (const guildRef of guildRefs) {
    const guild = await guildRef.fetch();
    const channels = await guild.channels.fetch();
    const syncableChannels = [...channels.values()].filter((channel) => isSyncableChannel(channel)) as SyncableChannel[];

    let messageCount = 0;
    let skippedBotMessages = 0;
    let skippedEmptyMessages = 0;

    console.log(`开始同步服务器 ${guild.name} (${guild.id})，共 ${syncableChannels.length} 个可同步频道。`);

    for (const channel of syncableChannels) {
      const channelSummary = await syncChannelHistory(guild, channel, store);
      messageCount += channelSummary.messageCount;
      skippedBotMessages += channelSummary.skippedBotMessages;
      skippedEmptyMessages += channelSummary.skippedEmptyMessages;
      console.log(
        `已同步 ${guild.name} / ${channel.name ?? channel.id}：${channelSummary.messageCount} 条消息。`
      );
    }

    await store.recordEvent("history_sync_completed", {
      guildId: guild.id,
      guildName: guild.name,
      channelCount: syncableChannels.length,
      messageCount,
      skippedBotMessages,
      skippedEmptyMessages
    });

    summaries.push({
      guildId: guild.id,
      guildName: guild.name,
      channelCount: syncableChannels.length,
      messageCount,
      skippedBotMessages,
      skippedEmptyMessages
    });
  }

  return summaries;
}
