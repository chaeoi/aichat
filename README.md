# AI Chat

一个自用或小团队使用的 ChatGPT 风格网页聊天工具。前端是零依赖的静态页面，后端是 FastAPI 服务，可对接任意 OpenAI 兼容 API（OpenAI、DeepSeek、各类中转站等），支持多 provider 自动降级。

## 功能特性

- **ChatGPT 风格界面**：深浅色自动切换、会话按日期分组、用户气泡 + 助手正文的消息流布局
- **移动端适配**：抽屉式侧边栏、安全区适配、中文输入法兼容（Enter 不会在候选词确认时误发送）
- **流式输出**：SSE 流式回复，随时停止生成，中断的部分回复也会保存
- **Markdown 渲染**：代码块（带复制按钮）、标题、列表、引用、链接、粗斜体，渲染前转义防 XSS
- **会话管理**：新建（首条消息才落库，不产生空会话）、重命名、删除、标题自动生成
- **多 Provider**：一个模型可配置多个上游，按顺序自动降级容错
- **多用户隔离**：每个访问密钥对应独立用户，数据互不可见；JWT 会话凭证
- **服务端历史**：对话上下文由服务端从数据库构建，客户端只发送新消息

## 目录结构

```text
index.html            # 前端入口（纯静态，可托管在任意静态服务/Pages）
assets/
  main.js             # 前端逻辑（无框架、无构建步骤）
  styles.css          # ChatGPT 风格样式，自动深色模式

program/              # 后端
  core/
    main.py           # FastAPI 路由
    chat.py           # 上游转发、SSE 解析、降级与持久化
    storage.py        # SQLite 存储
    auth.py           # 访问密钥 → JWT
    config.py         # 配置加载与校验
    schemas.py        # 请求/响应模型
  config.example.yaml
  Dockerfile
  requirements.txt
```

## 快速开始

### 1. 配置后端

```bash
cp program/config.example.yaml program/config.yaml
```

编辑 `program/config.yaml`，至少配置：

- `server.access_keys` — 登录密钥，每个密钥是一个独立用户
- `server.jwt_secret` — 生产环境务必改成随机值
- `providers` — 你的 OpenAI 兼容 API 地址、密钥和模型列表

环境变量 `ACCESS_KEYS`、`JWT_SECRET`、`CORS_ORIGINS`、`DATA_PATH`、`JWT_EXPIRES_MINUTES` 可覆盖对应配置项。

### 2. 运行后端

**Docker（推荐）**：推送到 GitHub 后 `.github/workflows/docker-publish.yml` 会自动构建多架构镜像。

```bash
cd program
mkdir -p data

docker run -d \
  --name aichat-backend \
  -p 8000:8000 \
  -v "$PWD/config.yaml:/app/config.yaml:ro" \
  -v "$PWD/data:/app/data" \
  your-dockerhub-username/aichat:latest
```

**源码运行**：

```bash
cd program
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn core.main:app --host 0.0.0.0 --port 8000
```

健康检查：`curl http://localhost:8000/health`

### 3. 打开前端

直接用浏览器打开 `index.html`，或把仓库根目录托管到任意静态服务（GitHub Pages、Cloudflare Pages、nginx 均可）。登录时填写后端地址和访问密钥。

## API

所有 `/api/*` 接口（除登录外）需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | `{access_key}` → JWT |
| `GET` | `/api/auth/me` | 校验当前凭证 |
| `GET` | `/api/providers` | 可用模型与 provider 列表 |
| `GET` | `/api/sessions` | 会话列表 |
| `GET` | `/api/sessions/{id}` | 会话详情 + 消息 |
| `PATCH` | `/api/sessions/{id}` | 重命名会话 |
| `DELETE` | `/api/sessions/{id}` | 删除会话 |
| `POST` | `/api/chat/stream` | `{session_id, content, model, provider?}` → SSE 流式回复。会话不存在时自动创建；上下文由服务端构建 |

## 待办清单（Roadmap）

对标 ChatGPT / Claude / Gemini 网页版及 Open WebUI、LobeChat、NextChat 等开源产品梳理的差距清单，按优先级分期，方便后续逐步完善。

### P0 — 对话核心体验补齐

- [ ] **重新生成回复**：对最后一条助手消息重试（需要后端支持删除尾部消息后重新推理）
- [ ] **编辑已发送消息**：编辑用户消息并从该处重新生成，形成分支；支持左右切换分支版本（ChatGPT 的 `< 2/2 >`）
- [ ] **代码语法高亮**：接入 highlight.js 或 Shiki（当前代码块仅等宽展示）
- [ ] **Markdown 补齐**：表格、任务列表、嵌套列表、LaTeX 数学公式（KaTeX）
- [ ] **推理模型支持**：解析 `reasoning_content` 思维链，折叠展示"思考过程"（DeepSeek-R1 / o 系列必需）
- [ ] **LLM 自动生成标题**：首轮对话后用小模型总结标题，替代现在的截断前 30 字
- [ ] **每会话参数设置**：系统提示词、temperature、max_tokens 面板
- [ ] **流式断线重连/请求重试**：网络抖动时不丢回复
- [ ] **对话搜索**：侧边栏搜索历史会话（标题 + 内容全文）

### P1 — 多模态与内容能力

- [ ] **图片上传**：对接 vision 模型（拖拽/粘贴/拍照上传，多图）
- [ ] **文件上传**：PDF / Word / 文本文件解析后注入上下文
- [ ] **语音输入**：浏览器 ASR 或 Whisper API 转写
- [ ] **语音朗读（TTS）**：朗读助手回复
- [ ] **图像生成**：对接 DALL·E / 兼容的生图接口
- [ ] **联网搜索**：搜索结果注入上下文并标注引用来源
- [ ] **工具调用 / MCP**：支持 function calling，接入 MCP 服务器生态
- [ ] **Artifacts / 代码预览**：HTML/SVG/Mermaid 即时预览面板（对标 Claude Artifacts、ChatGPT Canvas）
- [ ] **对话导出**：Markdown / 图片 / JSON 导出，分享只读链接
- [ ] **提示词库 / 助手预设**：可保存的角色预设（对标 GPTs / LobeChat 助手市场）
- [ ] **会话组织**：置顶、归档、文件夹/项目分组（对标 ChatGPT Projects）

### P2 — 工程化与部署

- [ ] **前后端同域部署**：FastAPI 直接托管静态文件，消除 CORS 与两次部署
- [ ] **PWA**：manifest + service worker，移动端可安装、基础离线能力
- [ ] **多用户体系**：注册/登录、管理后台（用户管理、模型权限、密钥管理），替代共享 access key
- [ ] **用量统计与限额**：按用户统计 token 用量，支持配额限制
- [ ] **速率限制与审计日志**：防滥用，关键操作留痕
- [ ] **数据备份与迁移**：会话导入导出、数据库备份脚本；数据量大后迁移 PostgreSQL
- [ ] **消息分页加载**：长会话滚动加载，避免一次拉全量
- [ ] **上下文 token 预算**：按 token 数而非消息条数裁剪上下文，超长时自动摘要
- [ ] **测试与 CI**：后端单元测试（pytest）+ 前端 E2E（Playwright）进 GitHub Actions
- [ ] **docker-compose 一键部署**：后端 + 前端静态托管 + HTTPS 反代示例
- [ ] **i18n**：中英文界面切换
- [ ] **手动主题切换**：浅色/深色/跟随系统三档（当前仅跟随系统）
- [ ] **多模型对比**：同一问题并行发给多个模型对比回答（对标 LobeChat / Arena）
- [ ] **记忆功能**：跨会话的用户偏好记忆（对标 ChatGPT Memory）

## 数据

聊天记录保存在 SQLite（默认 `program/data/chat.db`），删除会话会级联删除消息。多用户数据按 access key 派生的 user_id 隔离。
