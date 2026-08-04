# 阿里云 ECS 部署指南

两条路，**推荐第一条**（不需要 Docker）：

| 方案 | 命令 | 适用 |
|---|---|---|
| **裸机**（推荐） | `./install.sh` | Docker 装不上、内存小、想少一层抽象 |
| 容器 | `./deploy.sh` | 环境干净、习惯 Docker |

架构一样：**Nginx/Caddy(:80) → 后端(:8788)**，后端同时提供 API 和前端静态文件。
一个域名、零 CORS、零跨域 cookie 问题。

---

## 开始之前

先确认这两件事，它们决定了后面的选择：

| | 有备案域名 | 只有 IP |
|---|---|---|
| 访问 | `https://你的域名` | `http://服务器IP` |
| HTTPS | 自动申请 | 无 |
| 登录态 | 正常 | 正常（脚本会自动关 Secure cookie）|
| 适用 | 正式对外 | 临时演示 / 评审 |

> ⚠️ **国内 ECS 的 80/443 必须域名备案才能对外服务**，未备案会被阻断。
> 没备案就先用 IP 跑起来，备案下来后改一行即可切换。

服务器 **2 核 4G** 最舒服。1 核 2G 也行，脚本会自动加 swap 应付前端构建。

---

# 方案一：裸机部署（推荐）

## 第 0 步：放行安全组

**不做这步后面全白搭**，而且症状很迷惑 —— 服务器上 `curl` 完全正常，外面就是打不开。

阿里云控制台 → **ECS 实例** → **安全组** → **配置规则** → **入方向** → **手动添加**：

| 端口范围 | 授权对象 | 说明 |
|---|---|---|
| `80/80` | `0.0.0.0/0` | **即使只用 HTTPS 也必须开** —— 证书签发要走 80 校验 |
| `443/443` | `0.0.0.0/0` | HTTPS |

## 第 1 步：拉代码并安装

```bash
cd /opt
git clone https://github.com/nuronly/Ascend.git ladder
cd ladder
sudo ./install.sh
```

脚本会自动完成：

1. 识别系统（apt / dnf / yum 都支持）
2. 内存不足时自动加 2G swap
3. 装 uv + Python 3.12（**走清华源**）
4. 装 Node 22 + 构建前端（**走 npmmirror 镜像**）
5. 生成配置并自动填好 `JWT_SECRET`
6. 注册 systemd 服务
7. 配置 Nginx（**已关闭 SSE 缓冲**）
8. 自检

第一次运行会停在第 5 步让你填配置：

```bash
vi backend/.env
```

**必填三项**：

```bash
DEEPSEEK_API_KEY=sk-xxxxx           # 主力模型
MAAS_API_KEY=sk-ws-xxxxx            # embedding + 生图（DeepSeek 官方没这两项）
MAAS_BASE_URL=https://你的网关/compatible-mode/v1

SITE_ADDRESS=:80                    # 有备案域名就填域名，没有保持 :80
```

填完再跑一次：

```bash
sudo ./install.sh
```

## 第 2 步：验证

```bash
systemctl status ladder
curl http://127.0.0.1/api/health

# 逐路实测每个模型（能看出哪一路不通）
backend/.venv/bin/python backend/scripts/check_providers.py
```

浏览器打开 `http://你的服务器IP`，注册账号。

## 内存不足导致前端构建失败？

在**本地**构建好再传上去：

```bash
# 本地
cd frontend && npm run build
rsync -avz dist/ root@服务器IP:/opt/ladder/frontend/dist/

# 服务器
cd /opt/ladder && sudo ./install.sh --skip-build
```

## 日常运维

```bash
systemctl status ladder            # 状态
systemctl restart ladder           # 重启
journalctl -u ladder -f            # 系统日志
tail -f backend/logs/server.log    # 应用日志

cd /opt/ladder && git pull && sudo ./install.sh   # 更新
```

数据库在 `backend/data/ladder.db`，更新部署不会动它。

**备份**：

```bash
cp /opt/ladder/backend/data/ladder.db ~/backup-$(date +%F).db
```

## 加 HTTPS（域名备案后）

```bash
# 1. 改配置
sed -i 's/^SITE_ADDRESS=.*/SITE_ADDRESS=你的域名/' backend/.env
sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' backend/.env
sed -i 's|^CORS_ORIGINS=.*|CORS_ORIGINS=https://你的域名|' backend/.env
sudo ./install.sh

# 2. 申请证书（certbot 会自动改 Nginx 配置）
sudo yum install -y certbot python3-certbot-nginx   # 或 apt-get install
sudo certbot --nginx -d 你的域名
```

certbot 会自动配置续期。

---

# 方案二：Docker 部署

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
apt-get install -y docker-compose-plugin      # CentOS 系用 yum

# 国内必须配镜像加速，否则拉镜像超时
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{"registry-mirrors":["https://docker.m.daocloud.io","https://dockerproxy.com"]}
EOF
systemctl restart docker

cd /opt && git clone https://github.com/nuronly/Ascend.git ladder && cd ladder
./deploy.sh
```

配置文件是 `.env.prod`（不是 `backend/.env`）。其余同上。

---

# 排障

### 外网打不开，服务器本机 curl 正常

**安全组没放行。** 最高频原因，先查这个。

```bash
ss -lntp | grep ':80'        # 确认服务在监听
systemctl stop firewalld     # CentOS 系本机防火墙
ufw allow 80,443/tcp         # Ubuntu 系
```

### 登录成功后立刻退回登录页

HTTP 模式下 `COOKIE_SECURE` 没关。脚本会自动处理，手动改过的话：

```bash
sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=false/' backend/.env
systemctl restart ladder
```

> 原理：浏览器不保存 HTTP 响应里带 `Secure` 标志的 cookie，
> 于是登录接口成功、但下一个请求带不上凭证。

### 生成内容卡住，或很久后一次性全出来

反向代理缓冲了 SSE。`install.sh` 生成的 Nginx 配置已经关掉了，
如果你手写过配置，`location /api/` 里必须有：

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 600s;
```

大纲生成约 90 秒，超时设短了会中途断开。

### 服务起不来

```bash
tail -50 backend/logs/server.log
journalctl -u ladder -n 50 --no-pager
```

常见原因：`.env` 里 `JWT_SECRET` 为空、API key 没填、端口被占用。

### AI 功能报错

```bash
backend/.venv/bin/python backend/scripts/check_providers.py
```

逐路实测并区分失败性质：`key 无效` / `余额不足` / `被限流` / `超时`，
并标明哪些是致命的、哪些只是失去冗余。

### 证书申请失败

- 域名 A 记录是否指向本机（`dig +short 你的域名`）
- **80 端口是否放行**（校验走 80，不是 443）
- 域名是否已备案

---

# 上线后收口

参赛演示建议**保持开放但设上限**：

```bash
vi backend/.env
```
```bash
ALLOW_REGISTRATION=true      # 评委要能注册
MAX_USERS=50                 # 兜住上限
DAILY_TOKEN_QUOTA=1000000    # 单人每日额度，够很重度地用一天
```
```bash
systemctl restart ladder
```

演示结束后改成 `ALLOW_REGISTRATION=false`。
