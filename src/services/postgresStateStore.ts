import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
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

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToUser(row: any): BotUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    joinedAt: row.joined_at ? toIso(row.joined_at) : undefined,
    firstSeenAt: toIso(row.first_seen_at),
    lastSeenAt: toIso(row.last_seen_at),
    tags: row.tags ?? [],
    leadScore: row.lead_score ?? 0
  };
}

function rowToMessage(row: any): BotMessage {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    channelId: row.channel_id,
    content: row.content,
    createdAt: toIso(row.created_at),
    source: row.source ?? "discord_message"
  };
}

function rowToLead(row: any): LeadEvent {
  return {
    id: row.id,
    userId: row.user_id,
    messageId: row.message_id,
    username: row.username,
    leadScore: row.lead_score,
    reasons: row.reasons ?? [],
    tags: row.tags ?? [],
    suggestedAction: row.suggested_action,
    createdAt: toIso(row.created_at)
  };
}

function rowToEvent(row: any): BotEvent {
  return {
    id: row.id,
    type: row.type,
    createdAt: toIso(row.created_at),
    userId: row.user_id ?? undefined,
    metadata: row.metadata ?? {}
  };
}

export class PostgresStateStore implements StateStore {
  private readonly pool: Pool;

  constructor(
    databaseUrl: string,
    private readonly embeddingDimensions: number
  ) {
    this.pool = new Pool({
      connectionString: databaseUrl
    });
  }

  async init(): Promise<void> {
    const schemaPath = path.resolve(process.cwd(), "db/schema.sql");
    const schemaTemplate = await readFile(schemaPath, "utf8");
    const schemaSql = schemaTemplate.replace(/__EMBED_DIMENSIONS__/g, String(this.embeddingDimensions));
    await this.pool.query(schemaSql);
  }

  async getSnapshot(): Promise<BotState> {
    const [usersResult, messagesResult, leadsResult, eventsResult] = await Promise.all([
      this.pool.query("select * from users order by first_seen_at asc"),
      this.pool.query("select * from messages order by created_at asc"),
      this.pool.query("select * from leads order by created_at asc"),
      this.pool.query("select * from events order by created_at asc")
    ]);

    const users: Record<string, BotUser> = {};
    for (const row of usersResult.rows) {
      const user = rowToUser(row);
      users[user.id] = user;
    }

    return {
      users,
      messages: messagesResult.rows.map(rowToMessage),
      leads: leadsResult.rows.map(rowToLead),
      events: eventsResult.rows.map(rowToEvent)
    };
  }

  async getUser(userId: string): Promise<BotUser | undefined> {
    const result = await this.pool.query("select * from users where id = $1 limit 1", [userId]);
    return result.rows[0] ? rowToUser(result.rows[0]) : undefined;
  }

  async upsertUser(input: UserIdentityInput): Promise<BotUser> {
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `
        insert into users (id, username, display_name, joined_at, first_seen_at, last_seen_at, tags, lead_score)
        values ($1, $2, $3, $4, $5, $5, '{}', 0)
        on conflict (id) do update
        set username = excluded.username,
            display_name = excluded.display_name,
            joined_at = coalesce(users.joined_at, excluded.joined_at),
            last_seen_at = excluded.last_seen_at
        returning *
      `,
      [input.id, input.username, input.displayName, input.joinedAt ?? null, now]
    );

    return rowToUser(result.rows[0]);
  }

  async recordMessage(input: MessageInput): Promise<BotMessage> {
    const result = await this.pool.query(
      `
        insert into messages (id, user_id, username, channel_id, content, created_at, source)
        values ($1, $2, $3, $4, $5, $6, $7)
        returning *
      `,
      [input.id, input.userId, input.username, input.channelId, input.content, input.createdAt, input.source ?? "discord_message"]
    );

    return rowToMessage(result.rows[0]);
  }

  async updateUserSignals(userId: string, tags: string[], leadScore: number): Promise<BotUser | undefined> {
    const result = await this.pool.query(
      `
        update users
        set tags = (
              select array(
                select distinct value
                from unnest(coalesce(users.tags, '{}') || $2::text[]) as value
                order by value
              )
            ),
            lead_score = greatest(coalesce(lead_score, 0), $3),
            last_seen_at = $4
        where id = $1
        returning *
      `,
      [userId, tags, leadScore, new Date().toISOString()]
    );

    return result.rows[0] ? rowToUser(result.rows[0]) : undefined;
  }

  async recordLead(input: LeadInput): Promise<LeadEvent> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const result = await this.pool.query(
      `
        insert into leads (
          id, user_id, message_id, username, lead_score, reasons, tags, suggested_action, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning *
      `,
      [
        id,
        input.userId,
        input.messageId,
        input.username,
        input.leadScore,
        input.reasons,
        input.tags,
        input.suggestedAction,
        createdAt
      ]
    );

    return rowToLead(result.rows[0]);
  }

  async recordEvent(type: string, metadata: Record<string, unknown>, userId?: string): Promise<BotEvent> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const result = await this.pool.query(
      `
        insert into events (id, type, user_id, metadata, created_at)
        values ($1, $2, $3, $4::jsonb, $5)
        returning *
      `,
      [id, type, userId ?? null, JSON.stringify(metadata), createdAt]
    );

    return rowToEvent(result.rows[0]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
