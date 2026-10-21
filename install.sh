#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo ""
echo "==============================================="
echo "  CF Deployer - 安装向导"
echo "==============================================="
echo ""

# 读取已有 .env 作为默认值
DEFAULT_PORT=5100
DEFAULT_PASS=admin123

if [ -f docker/.env ]; then
  set -a
  . ./docker/.env 2>/dev/null || true
  set +a
  DEFAULT_PORT=${HOST_PORT:-$DEFAULT_PORT}
  DEFAULT_PASS=${WEB_PASSWORD:-$DEFAULT_PASS}
fi

# 检测是否已部署
EXISTING=0
if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^cf-deployer$'; then
  EXISTING=1
fi
if [ -f docker/.env ]; then
  EXISTING=1
fi

if [ "$EXISTING" = "1" ]; then
  echo "检测到已安装的版本："
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^cf-deployer$' && echo "  ✓ 存在容器 cf-deployer"
  [ -f docker/.env ] && echo "  ✓ 存在配置文件 docker/.env"
  echo ""
  echo "请选择操作："
  echo "  1) 全新安装（删除旧容器，重新配置）"
  echo "  2) 更新安装（保留数据，只重新构建）"
  echo "  3) 取消"
  read -p "请输入选项 [默认 1]: " MODE
  MODE=${MODE:-1}
else
  MODE=1
fi

if [ "$MODE" = "3" ]; then
  echo "已取消"
  exit 0
fi

# 更新安装
if [ "$MODE" = "2" ]; then
  echo ""
  echo "更新安装：保留配置和数据"
  cd docker
  docker compose down 2>/dev/null || true
  docker compose up -d --build
  PORT=$(grep '^HOST_PORT=' .env | cut -d= -f2)
  echo ""
  echo "✅ 更新完成！"
  echo "   访问：http://<服务器IP>:${PORT:-5100}"
  exit 0
fi

# 全新安装
if [ "$EXISTING" = "1" ]; then
  echo ""
  echo "⚠️  全新安装会停止并删除旧容器（数据目录保留）"
  read -p "确认继续？(y/N) " CONFIRM
  if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "已取消"
    exit 0
  fi
  docker rm -f cf-deployer 2>/dev/null || true
  echo "  ✓ 旧容器已删除"
  echo ""
fi

# 询问配置
echo "请配置部署参数（直接回车用默认值）："
echo ""

read -p "Web 端口 [$DEFAULT_PORT]: " HOST_PORT
HOST_PORT=${HOST_PORT:-$DEFAULT_PORT}

read -p "登录密码 [$DEFAULT_PASS]: " WEB_PASSWORD
WEB_PASSWORD=${WEB_PASSWORD:-$DEFAULT_PASS}

# 写 .env
mkdir -p docker
cat > docker/.env << ENVEOF
HOST_PORT=$HOST_PORT
WEB_PASSWORD=$WEB_PASSWORD
ENVEOF

echo ""
echo "✅ 已生成配置："
echo "---"
cat docker/.env
echo "---"

# 启动
echo ""
read -p "现在构建并启动容器？(Y/n) " GO
GO=${GO:-Y}
if [ "$GO" = "Y" ] || [ "$GO" = "y" ]; then
  cd docker
  docker compose up -d --build
  echo ""
  echo "✅ 安装完成！"
  echo "   访问：http://<服务器IP>:$HOST_PORT"
  echo "   登录密码：$WEB_PASSWORD"
else
  echo ""
  echo "已跳过启动。稍后执行："
  echo "  cd docker && docker compose up -d --build"
fi
