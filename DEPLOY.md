# 阿里云 ECS 部署指南

从零到能访问，大约 **15 分钟**（其中构建镜像占 5~8 分钟）。

---

## 开始之前

先确认两件事，它们决定了你走哪条路：

| | 有备案域名 | 只有 IP |
|---|---|---|
| 访问方式 | `https://你的域名` | `http://服务器IP` |
| HTTPS | Caddy 自动申请 | 无 |
| 登录态 | 正常 | 正常（会自动关掉 Secure cookie）|
| 适用 | 正式对外 | 临时演示 / 内网评审 |

> ⚠️ **国内 ECS 的 80/443 端口必须域名备案才能对外服务**，未备案会被阻断。
> 没备案就先用 IP 模式跑起来，备案下来后改一行配置即可切换，不用重新部署。

服务器建议 **2 核 4G** 起。1 核 2G 也能跑，但前端构建那一步可能内存不够（文末有解法）。

---

## 第一步：放行安全组端口

**这一步最容易被忽略，而且症状具有迷惑性** —— 服务在服务器上明明是好的，外面就是打不开。

阿里云控制台 → **ECS 实例** → 点进你的实例 → **安全组** → **配置规则** → **入方向** → **手动添加**：

| 端口范围 | 授权对象 | 说明 |
|---|---|---|
| `80/80` | `0.0.0.0/0` | HTTP。**即使只用 HTTPS 也必须开** —— Let's Encrypt 签发证书要走 80 端口校验 |
| `443/443` | `0.0.0.0/0` | HTTPS |

只开 443 不开 80，会卡在「证书申请失败」。

---

## 第二步：装 Docker

SSH 登录服务器后：

```bash
# 通用安装脚本，Alibaba Cloud Linux / Ubuntu / CentOS 都适用
curl -fsSL https://get.docker.com | sh

systemctl enable --now docker

# 装 compose 插件（Ubuntu/Debian）
apt-get update && apt-get install -y docker-compose-plugin
# CentOS / Alibaba Cloud Linux 用：
# yum install -y docker-compose-plugin
```

验证：

```bash
docker --version && docker compose version
```

### 配置镜像加速（国内必做）

不配的话拉镜像会非常慢甚至超时：

```bash
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.com",
    "https://mirror.ccs.tencentyun.com"
  ]
}
EOF
systemctl restart docker
```

---

## 第三步：拉代码

```bash
cd /opt
git clone https://github.com/nuronly/Ascend.git ladder
cd ladder
```

---

## 第四步：部署

```bash
./deploy.sh
```

第一次运行会生成 `.env.prod` 并**自动填好 JWT_SECRET**，然后停下来让你填配置：

```bash
vi .env.prod
```

**必填三项**：

```bash
# 有域名填域名，没有就保持 :80
SITE_ADDRESS=learn.example.com

# 主力模型
DEEPSEEK_API_KEY=sk-xxxxx

# embedding 和生图要用（DeepSeek 官方没有这两项能力）
MAAS_API_KEY=sk-ws-xxxxx
MAAS_BASE_URL=https://你的网关地址/compatible-mode/v1
```

填完再跑一次：

```bash
./deploy.sh
```

这次它会构建 → 启动 → 自检，完成后打印访问地址。

---

## 第五步：验证

```bash
# 服务器本机
curl http://127.0.0.1/api/health

# 供应商逐路体检（能看出哪一路不通）
docker compose exec app python scripts/check_providers.py

# 上线配置自检
docker compose exec app python scripts/preflight.py
```

然后浏览器打开访问地址，注册一个账号。

---

## 第六步：收口

注册完自己的账号后，按需要收紧准入。**参赛演示建议保持开放但设上限**：

```bash
vi .env.prod
```

```bash
ALLOW_REGISTRATION=true    # 评委要能注册
MAX_USERS=50               # 但兜住上限
DAILY_TOKEN_QUOTA=1000000  # 单人每日额度，足够重度体验
```

改完生效：

```bash
docker compose up -d
```

演示彻底结束后再改成 `ALLOW_REGISTRATION=false`。

---

## 日常运维

```bash
docker compose logs -f app     # 实时日志
docker compose restart app     # 重启应用
docker compose ps              # 查看状态
docker compose down            # 停止（数据保留在卷里）

# 更新代码
git pull && ./deploy.sh
```

数据库和勋章图片都在 `ladder-data` 卷里，`down` 和重建容器都不会丢。

**备份**：

```bash
docker compose exec app cp /app/data/ladder.db /app/data/backup.db
docker cp $(docker compose ps -q app):/app/data/backup.db ./backup-$(date +%F).db
```

---

## 排障

### 外网打不开，但服务器本机 curl 正常

**安全组没放行。** 这是最高频的原因，先查这个。

```bash
# 确认服务确实在监听
ss -lntp | grep -E ':80|:443'
```

如果服务器上还装了 firewalld/ufw：

```bash
systemctl stop firewalld && systemctl disable firewalld   # CentOS 系
ufw allow 80,443/tcp                                       # Ubuntu 系
```

### 构建卡在前端阶段 / 报 OOM

1 核 2G 内存容易在 `npm run build` 时被 OOM 杀掉。加临时 swap：

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

然后重新 `./deploy.sh`。

### 证书申请失败

```bash
docker compose logs caddy | tail -30
```

逐条核对：

- 域名 A 记录是否解析到本机公网 IP（`dig +short 你的域名`）
- **80 端口是否放行**（证书校验走 80，不是 443）
- 域名是否已备案（国内 ECS 未备案会被阻断，表现为校验超时）

实在搞不定就先退回 IP 模式：把 `SITE_ADDRESS` 改成 `:80`，`./deploy.sh`。

### 登录成功后立刻退回登录页

HTTP 模式下 `COOKIE_SECURE` 没关。`deploy.sh` 会自动处理，如果你手动改过配置：

```bash
sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=false/' .env.prod
docker compose up -d
```

> 原理：浏览器不会保存 HTTP 响应里带 `Secure` 标志的 cookie，
> 于是登录接口成功、但下一个请求带不上凭证。

### 生成内容卡住，或者等很久才一次性全出来

反向代理缓冲了 SSE。用本项目的 Caddyfile 不会有这问题（Caddy 默认不缓冲）。
如果你换成了 Nginx，必须加：

```nginx
proxy_buffering off;
proxy_read_timeout 600s;
```

### AI 功能报错

```bash
docker compose exec app python scripts/check_providers.py
```

它会逐路实测并区分失败性质：`key 无效` / `余额不足` / `被限流` / `超时`，
并标明哪些是致命的、哪些只是失去冗余。

---

## 切换到域名（备案下来之后）

```bash
sed -i 's/^SITE_ADDRESS=.*/SITE_ADDRESS=你的域名/' .env.prod
./deploy.sh
```

脚本会自动把 `COOKIE_SECURE` 改回 `true` 并同步 CORS 配置。
