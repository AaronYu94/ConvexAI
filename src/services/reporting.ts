import type { BotState } from "../types";

function dayKey(dateValue: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(dateValue));
}

function trimQuestion(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, 120);
}

function collectDayKeys(timezone: string, days: number): Set<string> {
  const keys = new Set<string>();
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    keys.add(dayKey(date.toISOString(), timezone));
  }
  return keys;
}

function buildPeriodReport(state: BotState, timezone: string, periodLabel: string, includedDayKeys: Set<string>): string {
  const messages = state.messages.filter((message) => includedDayKeys.has(dayKey(message.createdAt, timezone)));
  const leads = state.leads.filter((lead) => includedDayKeys.has(dayKey(lead.createdAt, timezone)));
  const events = state.events.filter((event) => includedDayKeys.has(dayKey(event.createdAt, timezone)));
  const newUsers = Object.values(state.users).filter((user) => includedDayKeys.has(dayKey(user.firstSeenAt, timezone)));

  const activeUsers = new Set(messages.map((message) => message.userId));
  const questionLines = messages
    .filter((message) => message.content.includes("?") || message.content.toLowerCase().startsWith("!ask"))
    .slice(-5)
    .map((message) => `- ${message.username}: ${trimQuestion(message.content)}`);

  const leadLines = leads
    .slice(-5)
    .map((lead) => `- ${lead.username}: ${lead.leadScore}/100 (${lead.tags.join(", ") || "no tags"})`);

  const tagCounts = new Map<string, number>();
  for (const lead of leads) {
    for (const tag of lead.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const topTags = [...tagCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([tag, count]) => `- ${tag}: ${count}`);

  const moderationActions = events.filter((event) => event.type === "moderation_blocked").length;

  return [
    `${periodLabel} (${timezone})`,
    `Messages: ${messages.length}`,
    `Active users: ${activeUsers.size}`,
    `New users: ${newUsers.length}`,
    `High-intent leads: ${leads.length}`,
    `Moderation actions: ${moderationActions}`,
    "",
    "Recent questions:",
    questionLines.length > 0 ? questionLines.join("\n") : "- No question-like messages yet.",
    "",
    "Lead tags:",
    topTags.length > 0 ? topTags.join("\n") : "- No lead tags yet.",
    "",
    "Recent lead alerts:",
    leadLines.length > 0 ? leadLines.join("\n") : "- No lead alerts yet."
  ].join("\n");
}

export function buildDailyReport(state: BotState, timezone: string): string {
  const today = collectDayKeys(timezone, 1);
  const [todayKey] = [...today];
  return buildPeriodReport(state, timezone, `Daily report for ${todayKey}`, today);
}

export function buildWeeklyReport(state: BotState, timezone: string): string {
  const lastSevenDays = collectDayKeys(timezone, 7);
  return buildPeriodReport(state, timezone, "Weekly report for the last 7 days", lastSevenDays);
}
