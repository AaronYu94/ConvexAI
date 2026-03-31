import { ChannelType, Client, TextChannel } from "discord.js";
import nodemailer from "nodemailer";
import type { BotConfig, LeadScoreResult } from "../types";
import { getAllReportChannelIds, getGuildConfig } from "../guildConfig";

function clip(input: string, maxLength = 1900): string {
  if (input.length <= maxLength) {
    return input;
  }

  return `${input.slice(0, maxLength - 20)}\n\n[truncated]`;
}

function parseRecipients(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export class AlertService {
  constructor(private readonly config: BotConfig) {}

  async sendLeadAlert(
    client: Client,
    guildId: string,
    username: string,
    messageContent: string,
    analysis: LeadScoreResult
  ): Promise<void> {
    const guildConfig = getGuildConfig(this.config, guildId);
    const body = [
      "High-intent user detected",
      `User: ${username}`,
      `Score: ${analysis.score}/100`,
      `Tags: ${analysis.tags.join(", ") || "none"}`,
      `Reasons: ${analysis.reasons.join(" | ") || "none"}`,
      `Summary: ${analysis.summary}`,
      `Suggested action: ${analysis.suggestedAction}`,
      `Message: ${messageContent}`
    ].join("\n");

    await Promise.all([
      this.sendDiscordMessage(client, guildConfig.alertChannelId, body),
      this.sendSlackMessage(`*Lead alert*\n${body.replace(/\n/g, "\n> ")}`),
      this.sendEmail("Community bot lead alert", body)
    ]);
  }

  async sendReport(client: Client, title: string, reportBody: string): Promise<void> {
    const body = `${title}\n\n${reportBody}`;
    const reportChannelIds = getAllReportChannelIds(this.config);
    await Promise.all([
      ...reportChannelIds.map((channelId) => this.sendDiscordMessage(client, channelId, body)),
      this.sendSlackMessage(`*${title}*\n${reportBody.replace(/\n/g, "\n> ")}`),
      this.sendEmail(title, reportBody)
    ]);
  }

  async sendAnswerHandoffAlert(
    client: Client,
    guildId: string,
    username: string,
    question: string,
    reason: string,
    draftAnswer: string
  ): Promise<void> {
    const guildConfig = getGuildConfig(this.config, guildId);
    const body = [
      "Human review requested",
      `User: ${username}`,
      `Reason: ${reason}`,
      `Question: ${question}`,
      "Draft answer:",
      draftAnswer
    ].join("\n");

    await Promise.all([
      this.sendDiscordMessage(client, guildConfig.alertChannelId, body),
      this.sendSlackMessage(`*Human review requested*\n${body.replace(/\n/g, "\n> ")}`),
      this.sendEmail("Community bot human review requested", body)
    ]);
  }

  private async sendDiscordMessage(client: Client, channelId: string | undefined, content: string): Promise<void> {
    if (!channelId) {
      return;
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      return;
    }

    await (channel as TextChannel).send(clip(content));
  }

  private async sendSlackMessage(text: string): Promise<void> {
    if (!this.config.slackWebhookUrl) {
      return;
    }

    await fetch(this.config.slackWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text })
    });
  }

  private async sendEmail(subject: string, text: string): Promise<void> {
    const recipients = parseRecipients(this.config.alertEmailTo);
    if (!this.config.smtpHost || !this.config.alertEmailFrom || recipients.length === 0) {
      return;
    }

    const transporter = nodemailer.createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: this.config.smtpSecure,
      auth:
        this.config.smtpUser && this.config.smtpPass
          ? {
              user: this.config.smtpUser,
              pass: this.config.smtpPass
            }
          : undefined
    });

    await transporter.sendMail({
      from: this.config.alertEmailFrom,
      to: recipients.join(", "),
      subject,
      text
    });
  }
}
