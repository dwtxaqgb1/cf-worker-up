# CF Worker 部署工具

基于 Cloudflare Workers API 的轻量级管理面板。支持多账号、在线编辑、一键部署、KV 管理、自定义域名绑定、备份回滚。

## 快速开始

### 方式 1：一键安装（推荐）

```bash
git clone https://github.com/dwtxaqgb1/cf-deployer.git && cd cf-deployer && chmod +x install.sh && ./install.sh
```

向导会问端口和密码，按提示输入即可。

### 方式 2：手动部署

```bash
git clone https://github.com/dwtxaqgb1/cf-deployer.git
cd cf-deployer/docker
# 改 docker-compose.yml 里的端口和密码
docker compose up -d --build
```

访问 `http://服务器IP:5100`

默认密码 `admin123`，**公开部署前请改密码**。

## 安全

- 默认密码 admin123，公开部署前必改
- 不要直接暴露公网，建议内网或加反代认证
- API Token 存在容器内 settings.json，注意不要提交
