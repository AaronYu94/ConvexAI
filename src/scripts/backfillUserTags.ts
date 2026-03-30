import { getConfig } from "../config";
import { createStateStore } from "../services/storeFactory";
import { scoreLeadIntent } from "../services/leadScorer";
import type { BotMessage } from "../types";

function parseGuildIdArg(): string | undefined {
  const [, , ...args] = process.argv;
  const explicit = args.find((arg) => !arg.startsWith("--"));
  if (explicit) {
    return explicit.trim();
  }

  const guildFlagIndex = args.findIndex((arg) => arg === "--guild");
  if (guildFlagIndex >= 0) {
    return args[guildFlagIndex + 1]?.trim();
  }

  return undefined;
}

function getEngagementTags(messageCount: number): string[] {
  if (messageCount >= 20) {
    return ["core_member", "active_user"];
  }

  if (messageCount >= 5) {
    return ["active_user"];
  }

  return ["community_member"];
}

function collectContentTags(messages: BotMessage[]) {
  const tags = new Set<string>();
  let score = 0;

  for (const message of messages) {
    const analysis = scoreLeadIntent(message.content);
    for (const tag of analysis.tags) {
      tags.add(tag);
    }
    score = Math.max(score, analysis.score);
  }

  return {
    tags: [...tags],
    score
  };
}

async function main() {
  const config = getConfig();
  const guildId = parseGuildIdArg() ?? config.discordGuildIds[0] ?? config.discordGuildId;
  if (!guildId) {
    throw new Error("Missing guild id. Pass one as an argument or configure DISCORD_GUILD_IDS.");
  }

  const store = createStateStore(config);
  await store.init();

  try {
    const snapshot = await store.getSnapshot();
    const guildMessages = snapshot.messages
      .filter((message) => message.guildId === guildId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    if (guildMessages.length === 0) {
      console.log(`No messages found for guild ${guildId}.`);
      return;
    }

    const groupedMessages = new Map<string, BotMessage[]>();
    for (const message of guildMessages) {
      const existing = groupedMessages.get(message.userId) ?? [];
      existing.push(message);
      groupedMessages.set(message.userId, existing);
    }

    let taggedUsers = 0;
    const summary: Array<{ userId: string; name: string; messageCount: number; tags: string[]; score: number }> = [];

    for (const [userId, messages] of groupedMessages.entries()) {
      const user = snapshot.users[userId];
      if (!user) {
        continue;
      }

      const engagementTags = getEngagementTags(messages.length);
      const content = collectContentTags(messages);
      const stickyTags = (user.tags ?? []).filter((tag) => tag === "spam_risk");
      const mergedTags = [...new Set([...stickyTags, ...engagementTags, ...content.tags])];

      if (mergedTags.length === 0) {
        continue;
      }

      await store.setUserSignals(userId, mergedTags, content.score);
      taggedUsers += 1;
      summary.push({
        userId,
        name: user.displayName || user.username,
        messageCount: messages.length,
        tags: mergedTags,
        score: content.score
      });
    }

    await store.recordEvent("guild_user_tags_backfilled", {
      guildId,
      taggedUsers,
      totalUsers: groupedMessages.size,
      tagsApplied: summary.reduce((total, item) => total + item.tags.length, 0)
    });

    console.log(
      JSON.stringify(
        {
          guildId,
          totalUsers: groupedMessages.size,
          taggedUsers,
          users: summary.sort((left, right) => right.messageCount - left.messageCount)
        },
        null,
        2
      )
    );
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
