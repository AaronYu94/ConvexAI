# Community AI Ops Bot

这是一个面向 Discord 社区运营场景的 AI 机器人项目。

当前版本已经覆盖第一版可用闭环：

- 基于知识库回答用户问题
- 导入本地和远程文档
- 识别定价、演示、企业采购、集成接入等意向信号
- 发送 Discord、Slack、邮件告警
- 输出日报和周报
- 支持本地 JSON 或 PostgreSQL 存储
- 提供给频道管理者使用的后台页面

## 已实现功能

机器人主流程：

- 新成员欢迎与基础引导
- 支持 `/ask` 和 `!ask` 问答
- 被 mention 或在指定频道内自动回复
- 基础垃圾信息与可疑链接拦截
- 高意向用户识别与跟进建议

知识库与检索：

- 递归扫描 `knowledge/` 目录
- 支持 `.md`、`.txt`、`.json`、`.html`、`.pdf`
- 支持通过 `knowledge/sources.json` 导入远程网页或额外文件
- 未配置向量检索时自动回退到关键词检索

通知与报表：

- Discord 内部告警
- Slack webhook 告警
- SMTP 邮件告警
- `/daily-report` 日报
- `/weekly-report` 周报
- 定时投递日报和周报

管理后台：

- 查看用户画像与标签
- 查看近期高意向线索
- 查看最近消息流
- 上传知识库文件
- 添加远程文档 URL
- 一键重载知识库

## 项目结构

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

## 快速开始

1. 在 Discord Developer Portal 创建应用和 Bot。
2. 开启以下权限：
   - `Server Members Intent`
   - `Message Content Intent`
3. 复制 `.env.example` 为 `.env` 并填写配置。
4. 安装依赖：

```bash
npm install
```

5. 注册斜杠命令：

```bash
npm run register:commands
```

6. 启动项目：

```bash
npm run dev
```

启动后会同时运行：

- Discord Bot
- 管理后台：`http://localhost:3010/admin`

## 支持的命令

- `/ask question:<text>`：向机器人提问
- `/daily-report`：查看日报
- `/weekly-report`：查看近 7 天周报
- `/reload-kb`：重新加载知识库

此外，以下场景也会自动回复：

- 用户 mention 机器人
- 消息出现在 `MONITORED_CHANNEL_IDS` 指定频道
- 用户发送 `!ask ...`

## 管理后台

这是一个给频道管理者和运营人员使用的轻量后台页面。

默认地址：

```txt
http://localhost:3010/admin
```

在后台里你可以：

- 上传 `.md`、`.txt`、`.json`、`.html`、`.pdf`
- 添加远程网页作为知识来源
- 重新加载知识库
- 查看用户画像、标签和 lead score
- 查看最近识别出的高意向线索
- 查看近期消息

如果你配置了后台账号密码，访问页面会要求 Basic Auth 登录。

## 知识库导入

程序会递归扫描 `KNOWLEDGE_DIR` 指向的目录，并导入以下文件类型：

- `.md`
- `.txt`
- `.json`
- `.html`
- `.pdf`

如果你想接入远程网页或额外文件，可以新建 `knowledge/sources.json`，格式参考 [sources.example.json](/Users/aaronyu/Desktop/ConvexAI/knowledge/sources.example.json)。

## 环境变量

Discord 与 OpenAI：

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `ANALYSIS_MODEL`
- `EMBEDDING_MODEL`
- `EMBEDDING_DIMENSIONS`

存储与知识库：

- `DATABASE_URL`
- `KNOWLEDGE_DIR`
- `KNOWLEDGE_SOURCES_FILE`
- `DATA_FILE`

机器人行为：

- `BOT_NAME`
- `WELCOME_CHANNEL_ID`
- `ALERT_CHANNEL_ID`
- `REPORT_CHANNEL_ID`
- `MONITORED_CHANNEL_IDS`

报表调度：

- `REPORT_TIMEZONE`
- `DAILY_REPORT_HOUR`
- `WEEKLY_REPORT_DAY`
- `WEEKLY_REPORT_HOUR`

告警渠道：

- `SLACK_WEBHOOK_URL`
- `ALERT_EMAIL_TO`
- `ALERT_EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`

管理后台：

- `ADMIN_PORT`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

## PostgreSQL 与 pgvector

如果你要切到生产型存储，建议：

1. 准备 PostgreSQL 数据库
2. 安装 `pgvector` 扩展
3. 配置 `DATABASE_URL`
4. 确保 `EMBEDDING_DIMENSIONS` 与 embedding 模型维度一致

项目启动时会自动执行 [schema.sql](/Users/aaronyu/Desktop/ConvexAI/db/schema.sql)。

## 当前回退策略

- 未配置 `DATABASE_URL`：使用本地 JSON 存储
- 未配置 `OPENAI_API_KEY`：使用关键词检索和规则意向识别
- 未配置 Slack 或邮箱：只发 Discord 告警
- 未配置报表投递目标：跳过定时日报和周报发送
- 未配置 `ADMIN_USERNAME` / `ADMIN_PASSWORD`：本地后台不启用额外登录保护
