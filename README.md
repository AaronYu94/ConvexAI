# Community AI Ops Bot

This project is a practical MVP for the kind of Discord bot shown in `Lucius_PPT_compressed.pdf`.

It now covers the first real product loop:

- answer questions from a mixed knowledge base
- import markdown, text, html, json, pdf, and remote documentation pages
- optionally store runtime data in PostgreSQL
- optionally index knowledge chunks in pgvector
- score lead intent with rules plus optional OpenAI analysis
- alert an internal Discord channel, Slack webhook, and email inbox
- generate daily and weekly reports

## What is implemented

Core bot flow:

- welcome and guide new members
- answer `/ask` and `!ask` questions
- auto-answer when mentioned or in monitored channels
- detect pricing, demo, enterprise, integration, and support signals
- block obvious spam and suspicious links

Storage and retrieval:

- local JSON fallback for zero-setup development
- optional PostgreSQL state store when `DATABASE_URL` is set
- optional pgvector knowledge search when both `DATABASE_URL` and `OPENAI_API_KEY` are set
- lexical fallback search when vectors are unavailable

Ops workflows:

- Discord internal lead alerts
- Slack webhook alerts
- SMTP email alerts
- slash commands for daily and weekly reports
- scheduled daily and weekly digest delivery

## Project structure

```txt
.
├── db/
│   └── schema.sql
├── knowledge/
│   ├── product-faq.md
│   └── sources.example.json
├── data/
│   └── state.json
├── src/
│   ├── bot/
│   │   └── registerCommands.ts
│   ├── services/
│   │   ├── alerts.ts
│   │   ├── digestScheduler.ts
│   │   ├── embeddings.ts
│   │   ├── knowledgeBase.ts
│   │   ├── knowledgeEngine.ts
│   │   ├── knowledgeImporter.ts
│   │   ├── leadAnalyzer.ts
│   │   ├── leadScorer.ts
│   │   ├── moderation.ts
│   │   ├── openaiResponder.ts
│   │   ├── postgresKnowledgeStore.ts
│   │   ├── postgresStateStore.ts
│   │   ├── reporting.ts
│   │   ├── storage.ts
│   │   └── storeFactory.ts
│   ├── config.ts
│   ├── index.ts
│   └── types.ts
├── .env.example
├── package.json
└── tsconfig.json
```

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable:
   - `Server Members Intent`
   - `Message Content Intent`
3. Copy `.env.example` to `.env`.
4. Install dependencies:

```bash
npm install
```

5. Register slash commands for your test guild:

```bash
npm run register:commands
```

6. Start the bot:

```bash
npm run dev
```

## Commands

- `/ask question:<text>`: ask the assistant
- `/daily-report`: show today's summary
- `/weekly-report`: show the last 7 days
- `/reload-kb`: reload local and remote knowledge sources

The bot also auto-replies when:

- it is mentioned in a message
- a message is sent in one of `MONITORED_CHANNEL_IDS`
- a user writes `!ask ...`

## Knowledge import

The bot always scans `KNOWLEDGE_DIR` recursively for:

- `.md`
- `.txt`
- `.json`
- `.html`
- `.pdf`

You can also add `knowledge/sources.json` to pull in remote pages or files. Start from [sources.example.json](/Users/aaronyu/Desktop/ConvexAI/knowledge/sources.example.json).

## Environment variables

Discord and OpenAI:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `ANALYSIS_MODEL`
- `EMBEDDING_MODEL`
- `EMBEDDING_DIMENSIONS`

Storage and knowledge:

- `DATABASE_URL`
- `KNOWLEDGE_DIR`
- `KNOWLEDGE_SOURCES_FILE`
- `DATA_FILE`

Bot behavior:

- `BOT_NAME`
- `WELCOME_CHANNEL_ID`
- `ALERT_CHANNEL_ID`
- `REPORT_CHANNEL_ID`
- `MONITORED_CHANNEL_IDS`

Reporting:

- `REPORT_TIMEZONE`
- `DAILY_REPORT_HOUR`
- `WEEKLY_REPORT_DAY`
- `WEEKLY_REPORT_HOUR`

Alerting:

- `SLACK_WEBHOOK_URL`
- `ALERT_EMAIL_TO`
- `ALERT_EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`

## PostgreSQL and pgvector

If you want production-style storage:

1. provision PostgreSQL
2. install the `pgvector` extension
3. set `DATABASE_URL`
4. keep `EMBEDDING_DIMENSIONS` aligned with your embedding model output

On startup, the bot applies [schema.sql](/Users/aaronyu/Desktop/ConvexAI/db/schema.sql).

## Current fallback behavior

- no `DATABASE_URL`: uses local JSON state
- no `OPENAI_API_KEY`: uses lexical retrieval and rule-based lead scoring
- no Slack or email config: only Discord alerts are sent
- no report destination configured: scheduled digests are skipped
