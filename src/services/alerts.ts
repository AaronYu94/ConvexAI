import { ChannelType, Client, TextChannel } from "discord.js";
import nodemailer from "nodemailer";
import type { BotConfig, LeadScoreResult } from "../types";
import { getAllReportChannelIds, getGuildConfig } from "../guildConfig";
import type { DashboardOpsSharePayload } from "./adminServer";

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
    handoffId: string,
    username: string,
    question: string,
    reason: string,
    draftAnswer: string
  ): Promise<void> {
    const guildConfig = getGuildConfig(this.config, guildId);
    const dashboardLink = this.buildDashboardLink(guildId, "handoffs");
    const body = [
      "Human review requested",
      `User: ${username}`,
      `Reason: ${reason}`,
      `Question: ${question}`,
      "Draft answer:",
      draftAnswer,
      dashboardLink ? `Dashboard: ${dashboardLink}` : undefined
    ]
      .filter(Boolean)
      .join("\n");

    await Promise.all([
      this.sendDiscordMessage(client, guildConfig.alertChannelId, body),
      this.sendSlackMessage(`*Human review requested*\n${body.replace(/\n/g, "\n> ")}`),
      this.sendSlackBlocks({
        text: "Human review requested",
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "Human review requested"
            }
          },
          {
            type: "section",
            fields: [
              {
                type: "mrkdwn",
                text: `*User*\n${username}`
              },
              {
                type: "mrkdwn",
                text: `*Reason*\n${reason}`
              }
            ]
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Question*\n>${question.replace(/\n/g, "\n> ")}`
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Draft answer*\n>${draftAnswer.replace(/\n/g, "\n> ")}`
            }
          },
          ...(dashboardLink
            ? [
                {
                  type: "actions",
                  elements: [
                    {
                      type: "button",
                      text: {
                        type: "plain_text",
                        text: "Open dashboard"
                      },
                      url: dashboardLink
                    }
                  ]
                }
              ]
            : [])
        ]
      }),
      this.sendLarkCard("需要人工接管", [
        `用户：${username}`,
        `原因：${reason}`,
        `问题：${question}`,
        `草稿：${draftAnswer}`
      ], dashboardLink, [
        {
          label: "标记已接手",
          action: "ack_handoff",
          type: "primary",
          value: {
            handoffId,
            guildId
          }
        }
      ]),
      this.sendEmail("Community bot human review requested", body)
    ]);
  }

  async shareOpsPreview(
    client: Client,
    guildId: string,
    payload: DashboardOpsSharePayload
  ): Promise<void> {
    const guildConfig = getGuildConfig(this.config, guildId);
    const dashboardLink = this.buildDashboardLink(guildId, "ops");
    const candidateLines = payload.candidates.map((candidate, index) =>
      `${index + 1}. ${candidate.displayName} (@${candidate.username})${candidate.primaryTag ? ` · ${candidate.primaryTag}` : ""}\n   ${candidate.rationale}`
    );
    const body = [
      payload.title,
      `Instruction: ${payload.instruction}`,
      payload.summary,
      payload.draftedMessage ? `Draft message: ${payload.draftedMessage}` : undefined,
      "Candidates:",
      candidateLines.join("\n"),
      dashboardLink ? `Dashboard: ${dashboardLink}` : undefined
    ]
      .filter(Boolean)
      .join("\n");

    await Promise.all([
      this.sendDiscordMessage(client, guildConfig.alertChannelId, body),
      this.sendSlackMessage(`*${payload.title}*\n${body.replace(/\n/g, "\n> ")}`),
      this.sendSlackBlocks({
        text: payload.title,
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: payload.title
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Instruction*\n${payload.instruction}`
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Summary*\n${payload.summary}`
            }
          },
          ...(payload.draftedMessage
            ? [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*Draft message*\n>${payload.draftedMessage.replace(/\n/g, "\n> ")}`
                  }
                }
              ]
            : []),
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: candidateLines.length > 0 ? `*Candidates*\n${candidateLines.join("\n")}` : "*Candidates*\nNone"
            }
          },
          ...(dashboardLink
            ? [
                {
                  type: "actions",
                  elements: [
                    {
                      type: "button",
                      text: {
                        type: "plain_text",
                        text: "Open dashboard"
                      },
                      url: dashboardLink
                    }
                  ]
                }
              ]
            : [])
        ]
      }),
      this.sendLarkCard(
        payload.title,
        [
          `任务：${payload.instruction}`,
          payload.summary,
          payload.draftedMessage ? `草稿：${payload.draftedMessage}` : undefined,
          candidateLines.length > 0 ? `候选人：\n${candidateLines.join("\n")}` : "候选人：无"
        ].filter((line): line is string => Boolean(line)),
        dashboardLink,
        [
          {
            label: "标记已收到",
            action: "ack_ops_preview",
            type: "default",
            value: {
              guildId,
              instruction: payload.instruction
            }
          }
        ]
      ),
      this.sendEmail(payload.title, body)
    ]);
  }

  async sendActivitySubmissionReviewCard(
    guildId: string,
    submission: {
      id: string;
      username: string;
      displayName: string;
      createdAt: string;
      content: string;
      screeningSummary: string;
      extractedFields: Array<{ label: string; value: string }>;
      reviewNote?: string;
    }
  ): Promise<void> {
    if (!this.config.larkWebhookUrl) {
      return;
    }

    const dashboardLink = this.buildDashboardLink(guildId, "campaigns");
    const extractedFieldLines = submission.extractedFields.map((field) => `${field.label}：${field.value}`);

    await this.sendLarkCard(
      "活动候选待审核",
      [
        `用户：${submission.displayName} (@${submission.username})`,
        `提交时间：${submission.createdAt}`,
        extractedFieldLines.length > 0 ? `提取字段：\n${extractedFieldLines.join("\n")}` : undefined,
        `初筛说明：${submission.screeningSummary}`,
        submission.reviewNote ? `当前备注：${submission.reviewNote}` : undefined,
        `原始内容：${clip(submission.content, 720)}`
      ].filter((line): line is string => Boolean(line)),
      dashboardLink,
      [
        {
          label: "通过",
          action: "approve_activity_submission",
          type: "primary",
          value: {
            submissionId: submission.id,
            guildId
          }
        },
        {
          label: "驳回",
          action: "reject_activity_submission",
          type: "danger",
          value: {
            submissionId: submission.id,
            guildId
          }
        }
      ]
    );
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

  private async sendSlackBlocks(payload: { text: string; blocks: unknown[] }): Promise<void> {
    if (!this.config.slackWebhookUrl) {
      return;
    }

    await fetch(this.config.slackWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  }

  private async sendLarkCard(
    title: string,
    lines: string[],
    dashboardLink?: string,
    actions: Array<{
      label: string;
      action: string;
      type?: "default" | "primary" | "danger";
      value?: Record<string, string>;
    }> = []
  ): Promise<void> {
    if (!this.config.larkWebhookUrl) {
      return;
    }

    const elements: Array<Record<string, unknown>> = lines.map((line) => ({
      tag: "markdown",
      content: line
    }));

    const buttonActions: Array<Record<string, unknown>> = actions.map((action) => ({
      tag: "button",
      text: {
        tag: "plain_text",
        content: action.label
      },
      type: action.type ?? "default",
      value: {
        action: action.action,
        ...(action.value ?? {})
      }
    }));

    if (dashboardLink) {
      buttonActions.push({
        tag: "button",
        text: {
          tag: "plain_text",
          content: "打开后台"
        },
        type: "default",
        url: dashboardLink
      });
    }

    if (buttonActions.length > 0) {
      elements.push({
        tag: "action",
        actions: buttonActions
      });
    }

    await fetch(this.config.larkWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        msg_type: "interactive",
        card: {
          config: {
            wide_screen_mode: true
          },
          header: {
            title: {
              tag: "plain_text",
              content: title
            },
            template: "blue"
          },
          elements
        }
      })
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

  private buildDashboardLink(guildId: string, anchor: string): string | undefined {
    if (!this.config.adminBaseUrl) {
      return undefined;
    }

    const separator = this.config.adminBaseUrl.includes("?") ? "&" : "?";
    return `${this.config.adminBaseUrl}${separator}guildId=${encodeURIComponent(guildId)}#${anchor}`;
  }
}
