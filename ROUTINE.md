# 社群 AI 运营系统开发流程

## 0. 目标
做一个最小可用版本（MVP）：
- 接 Discord 社群
- 自动回答常见问题
- 给用户打标签
- 识别购买意向
- 通知销售/运营
- 输出基础数据报表

---

## 1. 技术选型
### 后端
- Node.js / Python 二选一
- 推荐：Node.js + TypeScript

### 数据库
- PostgreSQL

### 缓存
- Redis

### 向量检索
- pgvector / Pinecone / Weaviate
- MVP 推荐：pgvector

### LLM
- OpenAI API

### 渠道接入
- Discord Bot API
- 后续再扩 Slack / Telegram

### 部署
- Docker
- Railway / Render / Fly.io / AWS

---

## 2. 系统模块
### 模块 A：渠道接入
功能：
- 接收 Discord 消息
- 识别频道、用户、时间、上下文
- 把消息写入数据库

输入：
- 用户消息
- 用户 ID
- 频道信息

输出：
- 标准化消息对象

---

### 模块 B：知识库
功能：
- 导入 FAQ / 官网 / 产品文档
- 分段切块
- embedding
- 建立向量索引

输入：
- docs / faq / markdown / pdf 文本

输出：
- 可检索知识库

---

### 模块 C：问答引擎
功能：
- 收到用户问题后检索相关内容
- 用 RAG 生成回答
- 控制回答风格和长度
- 没把握时 fallback

规则：
- 不瞎编
- 不确定就说不知道
- 优先引用知识库

输出：
- 最终回复内容

---

### 模块 D：用户画像 / 标签系统
功能：
- 根据行为和对话打标签

基础标签示例：
- new_user
- active_user
- high_intent
- technical_user
- pricing_interest
- demo_interest
- support_issue

来源：
- 消息内容
- 活跃频率
- 点击行为
- 历史提问

输出：
- user_profile
- user_tags

---

### 模块 E：商机识别
功能：
- 识别购买意图
- 识别 demo / pricing / integration / enterprise 信号
- 触发通知

实现方式：
- 第一版先用规则 + LLM 分类
- 不要一开始上复杂模型

高意向信号示例：
- “price”
- “demo”
- “trial”
- “team”
- “how to deploy”
- “enterprise”
- “can we use this in our company”

输出：
- lead_score
- lead_reason
- lead_event

---

### 模块 F：通知系统
功能：
- 把高意向用户推送给销售或运营

通知目标：
- Slack webhook
- Email
- Discord private channel

通知内容：
- 用户名
- 原始消息
- 标签
- 意向分数
- 建议跟进动作

---

### 模块 G：自动运营
功能：
- welcome message
- onboarding guide
- 新用户引导
- 问题追问
- 沉默用户 follow-up

示例：
- 新用户进入服务器后自动发欢迎语
- 第一次提问后自动推荐 docs
- 问了 pricing 后引导预约 demo

---

### 模块 H：风控 / 审核
功能：
- 广告识别
- spam 检测
- 敏感词处理
- 恶意链接拦截

动作：
- 删除消息
- 警告
- 禁言
- 封禁

---

### 模块 I：分析看板
功能：
- DAU / WAU
- 常见问题
- 高意向用户数
- 平均响应时间
- 解决率
- 转化漏斗

第一版不用前端大屏：
- 先输出 daily / weekly report
- 或简单管理后台

---

## 3. 数据库设计
至少建这些表：

### users
- id
- platform_user_id
- username
- joined_at
- role
- created_at
- updated_at

### messages
- id
- user_id
- channel_id
- content
- message_type
- created_at

### knowledge_chunks
- id
- source
- content
- embedding
- created_at

### user_tags
- id
- user_id
- tag
- score
- created_at

### leads
- id
- user_id
- message_id
- lead_score
- lead_reason
- status
- created_at

### events
- id
- user_id
- event_type
- metadata
- created_at

---

## 4. API 设计
### 内部接口
- POST /webhook/discord
- POST /kb/import
- POST /chat/respond
- POST /lead/evaluate
- POST /moderation/check
- GET /report/daily

---

## 5. 开发顺序
### Phase 1：最小闭环
先完成：
1. Discord Bot 接入
2. PostgreSQL
3. 知识库导入
4. RAG 回答
5. 消息存储
6. 高意向识别
7. Slack 通知

验收标准：
- 用户发问题，机器人能答
- 遇到 pricing/demo 问题能通知运营

---

### Phase 2：标签和自动化
再做：
1. 用户标签系统
2. welcome / onboarding
3. follow-up
4. spam 检测
5. 日报周报

---

### Phase 3：产品化
最后做：
1. 管理后台
2. 多平台支持
3. 权限系统
4. 客户级配置
5. 多租户架构
6. 计费系统

---

## 6. MVP 验收标准
必须满足：
- 能接 Discord 消息
- 能基于知识库回答问题
- 能记录用户与消息
- 能识别高意向对话
- 能把高意向线索推送出去
- 能生成简单报表

如果这 6 个没通，不要做花里胡哨的 UI

---

## 7. 给 Codex 的执行原则
1. 先做 MVP，不做大而全
2. 先单平台（Discord）
3. 先规则 + LLM，不训练模型
4. 先命令行和 API 通，再补后台
5. 每个模块都要可独立测试
6. 所有 prompt、规则、标签配置都放配置文件
7. 所有 webhook、API key、数据库连接都走环境变量
8. 优先可维护性，不优先炫技

---

## 8. 建议目录结构
```txt
/community-ai-ops
  /apps
    /bot
    /api
    /worker
    /admin
  /packages
    /db
    /core
    /rag
    /lead-scoring
    /moderation
    /shared
  /docs
  /.env.example
  /docker-compose.yml
  /README.md