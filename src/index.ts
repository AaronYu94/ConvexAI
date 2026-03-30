import { randomUUID } from "node:crypto";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel
} from "discord.js";
import { getConfig } from "./config";
import { AlertService } from "./services/alerts";
import { AdminServer } from "./services/adminServer";
import { DigestScheduler } from "./services/digestScheduler";
import { KnowledgeEngine } from "./services/knowledgeEngine";
import { LeadAnalyzer } from "./services/leadAnalyzer";
import { moderateMessage } from "./services/moderation";
import { OpenAIResponder } from "./services/openaiResponder";
import { buildDailyReport, buildWeeklyReport } from "./services/reporting";
import { createStateStore } from "./services/storeFactory";

function clipForDiscord(input: string, maxLength = 1900): string {
  if (input.length <= maxLength) {
    return input;
  }

  return `${input.slice(0, maxLength - 20)}\n\n[truncated]`;
}

function shouldAutoAnswer(message: Message, monitoredChannelIds: string[], botUserId: string): boolean {
  if (message.author.bot) {
    return false;
  }

  if (message.mentions.users.has(botUserId)) {
    return true;
  }

  if (monitoredChannelIds.includes(message.channelId)) {
    return true;
  }

  return message.content.trim().toLowerCase().startsWith("!ask ");
}

function normalizeQuestion(message: Message, botUserId: string): string {
  const mentionPattern = new RegExp(`<@!?${botUserId}>`, "g");
  return message.content.replace(mentionPattern, "").replace(/^!ask\s+/i, "").trim();
}

async function sendWelcomeIfNeeded(message: Message, botName: string): Promise<void> {
  await message.reply(
    [
      `Welcome to the server. I am ${botName}.`,
      "You can mention me or use `!ask ...` if you want product, setup, or onboarding help."
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const config = getConfig();
  const store = createStateStore(config);
  await store.init();

  const knowledge = new KnowledgeEngine(config);
  const knowledgeCount = await knowledge.reload();
  const responder = new OpenAIResponder(config);
  const leadAnalyzer = new LeadAnalyzer(config);
  const alerts = new AlertService(config);
  const scheduler = new DigestScheduler(config, store, alerts);
  const adminServer = new AdminServer(config, store, knowledge);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  client.once(Events.ClientReady, (readyClient) => {
    scheduler.start(client);
    console.log(`${readyClient.user.tag} is online with ${knowledgeCount} knowledge chunks.`);
  });

  await adminServer.start();

  client.on(Events.GuildMemberAdd, async (member) => {
    await store.upsertUser({
      id: member.id,
      username: member.user.username,
      displayName: member.displayName,
      joinedAt: member.joinedAt?.toISOString()
    });

    await store.recordEvent(
      "member_joined",
      {
        guildId: member.guild.id
      },
      member.id
    );

    if (!config.welcomeChannelId) {
      return;
    }

    const channel = await member.guild.channels.fetch(config.welcomeChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      return;
    }

    await (channel as TextChannel).send(
      [
        `Welcome <@${member.id}>.`,
        `I am ${config.botName}.`,
        "Ask me product or onboarding questions any time, and I can also route pricing or demo requests to a human teammate."
      ].join("\n")
    );
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      if (interaction.commandName === "daily-report") {
        const report = buildDailyReport(await store.getSnapshot(), config.reportTimezone);
        await interaction.reply({ content: clipForDiscord(report), ephemeral: true });
        return;
      }

      if (interaction.commandName === "weekly-report") {
        const report = buildWeeklyReport(await store.getSnapshot(), config.reportTimezone);
        await interaction.reply({ content: clipForDiscord(report), ephemeral: true });
        return;
      }

      if (interaction.commandName === "reload-kb") {
        await interaction.deferReply({ ephemeral: true });
        const chunkCount = await knowledge.reload();
        await store.recordEvent("knowledge_reloaded", { chunkCount });
        await interaction.editReply(`Reloaded ${chunkCount} knowledge chunks.`);
        return;
      }

      if (interaction.commandName !== "ask") {
        return;
      }

      const question = interaction.options.getString("question", true).trim();
      const displayName =
        interaction.member && "displayName" in interaction.member
          ? interaction.member.displayName
          : interaction.user.globalName ?? interaction.user.username;

      await store.upsertUser({
        id: interaction.user.id,
        username: interaction.user.username,
        displayName
      });

      await store.recordMessage({
        id: `slash-${interaction.id}`,
        userId: interaction.user.id,
        username: interaction.user.username,
        channelId: interaction.channelId,
        content: question,
        createdAt: interaction.createdAt.toISOString(),
        source: "slash_ask"
      });

      await store.recordEvent(
        "slash_question_received",
        {
          question,
          channelId: interaction.channelId
        },
        interaction.user.id
      );

      await interaction.deferReply();
      const results = await knowledge.search(question);
      const answer = await responder.answer(question, results);

      await store.recordEvent("slash_answer_sent", {
        question,
        usedFallback: answer.usedFallback,
        resultCount: results.length
      });

      await interaction.editReply(clipForDiscord(answer.text));
    } catch (error) {
      console.error("Interaction handler failed", error);
      const safeMessage = "The bot hit an error while processing that command.";

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(safeMessage).catch(() => undefined);
        return;
      }

      await interaction.reply({ content: safeMessage, ephemeral: true }).catch(() => undefined);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!message.guild || message.author.bot) {
      return;
    }

    const existingUser = await store.getUser(message.author.id);
    await store.upsertUser({
      id: message.author.id,
      username: message.author.username,
      displayName: message.member?.displayName ?? message.author.globalName ?? message.author.username
    });

    const storedMessage = await store.recordMessage({
      id: message.id || randomUUID(),
      userId: message.author.id,
      username: message.author.username,
      channelId: message.channelId,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      source: "discord_message"
    });

    const moderation = moderateMessage(message.content);
    if (moderation.shouldBlock) {
      try {
        await message.delete();
      } catch {
        await message.reply("I flagged this message as suspicious, but I do not have permission to delete it.");
      }

      await store.recordEvent(
        "moderation_blocked",
        {
          messageId: message.id,
          reason: moderation.reason
        },
        message.author.id
      );
      return;
    }

    if (!existingUser) {
      await sendWelcomeIfNeeded(message, config.botName);
    }

    const analysis = await leadAnalyzer.analyze(message.content);
    if (analysis.tags.length > 0) {
      await store.updateUserSignals(message.author.id, analysis.tags, analysis.score);
    }

    if (analysis.shouldNotify) {
      const lead = await store.recordLead({
        userId: message.author.id,
        messageId: storedMessage.id,
        username: message.author.username,
        leadScore: analysis.score,
        reasons: analysis.reasons,
        tags: analysis.tags,
        suggestedAction: analysis.suggestedAction
      });

      await store.recordEvent(
        "lead_detected",
        {
          leadId: lead.id,
          messageId: message.id,
          tags: lead.tags,
          source: analysis.source,
          confidence: analysis.confidence
        },
        message.author.id
      );

      await alerts.sendLeadAlert(client, message.author.username, message.content, analysis);
    }

    const botUserId = client.user?.id;
    if (!botUserId || !shouldAutoAnswer(message, config.monitoredChannelIds, botUserId)) {
      return;
    }

    const question = normalizeQuestion(message, botUserId);
    if (!question) {
      return;
    }

    await message.channel.sendTyping();
    const results = await knowledge.search(question);
    const answer = await responder.answer(question, results);

    await store.recordEvent(
      "message_answer_sent",
      {
        question,
        usedFallback: answer.usedFallback,
        resultCount: results.length
      },
      message.author.id
    );

    await message.reply(clipForDiscord(answer.text));
  });

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    await adminServer.stop();
    await knowledge.close();
    await store.close();
    client.destroy();
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  await client.login(config.discordToken);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
