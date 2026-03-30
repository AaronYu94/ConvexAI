import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BotEvent,
  BotMessage,
  BotState,
  BotUser,
  LeadEvent,
  LeadInput,
  MessageInput,
  StateStore,
  UserIdentityInput
} from "../types";

const EMPTY_STATE: BotState = {
  users: {},
  messages: [],
  leads: [],
  events: []
};

export class JsonStateStore implements StateStore {
  private state: BotState = structuredClone(EMPTY_STATE);
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as BotState;
      this.state = {
        users: parsed.users ?? {},
        messages: parsed.messages ?? [],
        leads: parsed.leads ?? [],
        events: parsed.events ?? []
      };
    } catch {
      this.state = structuredClone(EMPTY_STATE);
      await this.persist();
    }
  }

  async getSnapshot(): Promise<BotState> {
    return structuredClone(this.state);
  }

  async getUser(userId: string): Promise<BotUser | undefined> {
    return this.state.users[userId];
  }

  async upsertUser(input: UserIdentityInput): Promise<BotUser> {
    const existing = this.state.users[input.id];
    const now = new Date().toISOString();

    const merged: BotUser = {
      id: input.id,
      username: input.username,
      displayName: input.displayName,
      joinedAt: input.joinedAt ?? existing?.joinedAt,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      tags: existing?.tags ?? [],
      leadScore: existing?.leadScore ?? 0
    };

    this.state.users[input.id] = merged;
    await this.persist();
    return merged;
  }

  async recordMessage(input: MessageInput): Promise<BotMessage> {
    const message: BotMessage = {
      ...input,
      source: "discord"
    };

    this.state.messages.push(message);
    await this.persist();
    return message;
  }

  async updateUserSignals(userId: string, tags: string[], leadScore: number): Promise<BotUser | undefined> {
    const user = this.state.users[userId];
    if (!user) {
      return undefined;
    }

    const mergedTags = new Set([...user.tags, ...tags]);
    user.tags = [...mergedTags].sort();
    user.leadScore = Math.max(user.leadScore, leadScore);
    user.lastSeenAt = new Date().toISOString();
    await this.persist();
    return user;
  }

  async recordLead(input: LeadInput): Promise<LeadEvent> {
    const lead: LeadEvent = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };

    this.state.leads.push(lead);
    await this.persist();
    return lead;
  }

  async recordEvent(type: string, metadata: Record<string, unknown>, userId?: string): Promise<BotEvent> {
    const event: BotEvent = {
      id: randomUUID(),
      type,
      userId,
      metadata,
      createdAt: new Date().toISOString()
    };

    this.state.events.push(event);
    await this.persist();
    return event;
  }

  async close(): Promise<void> {
    await this.writeQueue;
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const payload = JSON.stringify(this.state, null, 2);
      await writeFile(this.filePath, payload, "utf8");
    });

    await this.writeQueue;
  }
}
