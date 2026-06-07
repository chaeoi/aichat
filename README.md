# AI Chat

一个自用或小团队使用的 ChatGPT 风格网页聊天工具。

## 目录

```text
index.html
assets/
  main.js
  styles.css

program/
  core/
  config.example.yaml
  Dockerfile
  requirements.txt
```

## 配置

复制后端配置：

```bash
cp program/config.example.yaml program/config.yaml
```

编辑 `program/config.yaml`，至少配置：

- `server.access_keys`
- `server.jwt_secret`
- `providers`

## 后端

后端通过 Docker 镜像运行。推送到 GitHub 后，`.github/workflows/docker-image.yml` 会构建镜像。

启动示例：

```bash
cd program
mkdir -p data

docker run -d \
  --name aichat-backend \
  -e PORT=8000 \
  -p 8000:8000 \
  -v "$PWD/config.yaml:/app/config.yaml:ro" \
  -v "$PWD/data:/app/data" \
  your-dockerhub-username/aichat:latest
```

健康检查：

```bash
curl http://localhost:8000/health
```

## 前端

直接打开：

```text
index.html
```

登录时填写后端地址和 `program/config.yaml` 里的访问密钥。

## 数据

聊天记录保存在：

```text
program/data/chat.db
```
