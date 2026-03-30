import type { Client } from "discord.js";
import type { BotConfig, StateStore } from "../types";
import { AlertService } from "./alerts";
import { buildDailyReport, buildWeeklyReport } from "./reporting";

function getZonedParts(date: Date, timeZone: string): { weekday: string; hour: number; day: string } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value.toUpperCase().slice(0, 3) ?? "MON";
  const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "0", 10);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";

  return {
    weekday,
    hour,
    day: `${year}-${month}-${day}`
  };
}

function weekBucket(date: Date, timeZone: string): string {
  const keys: string[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    keys.push(getZonedParts(new Date(date.getTime() - offset * 24 * 60 * 60 * 1000), timeZone).day);
  }

  return keys.sort()[0] ?? getZonedParts(date, timeZone).day;
}

export class DigestScheduler {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: BotConfig,
    private readonly store: StateStore,
    private readonly alerts: AlertService
  ) {}

  start(client: Client): void {
    this.stop();
    void this.tick(client);
    this.timer = setInterval(() => {
      void this.tick(client);
    }, 15 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(client: Client): Promise<void> {
    if (!this.config.reportChannelId && !this.config.slackWebhookUrl && !this.config.alertEmailTo) {
      return;
    }

    const now = new Date();
    const zoned = getZonedParts(now, this.config.reportTimezone);
    const snapshot = await this.store.getSnapshot();
    const delivered = new Set(
      snapshot.events
        .filter((event) => event.type === "report_sent")
        .map((event) => String(event.metadata.reportKey ?? ""))
    );

    if (zoned.hour === this.config.dailyReportHour) {
      const reportKey = `daily:${zoned.day}`;
      if (!delivered.has(reportKey)) {
        const report = buildDailyReport(snapshot, this.config.reportTimezone);
        await this.alerts.sendReport(client, "Daily community digest", report);
        await this.store.recordEvent("report_sent", { reportKey, period: "daily" });
      }
    }

    if (zoned.weekday === this.config.weeklyReportDay && zoned.hour === this.config.weeklyReportHour) {
      const reportKey = `weekly:${weekBucket(now, this.config.reportTimezone)}`;
      if (!delivered.has(reportKey)) {
        const report = buildWeeklyReport(snapshot, this.config.reportTimezone);
        await this.alerts.sendReport(client, "Weekly community digest", report);
        await this.store.recordEvent("report_sent", { reportKey, period: "weekly" });
      }
    }
  }
}
