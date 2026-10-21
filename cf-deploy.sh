#!/bin/bash

CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
CF_TOKEN="${CF_TOKEN:-}"
CF_WORKER_NAME="${CF_WORKER_NAME:-}"
CF_KV_ID="${CF_KV_ID:-}"
CF_KV_BINDING="${CF_KV_BINDING:-CONFIG_KV}"
WORKER_FILE="${CF_WORKER_FILE:-}"
BACKUP_DIR="${CF_BACKUP_DIR:-}"
CF_PUBLIC_BASE="${CF_PUBLIC_BASE:-}"
CF_SCRIPT_FORMAT="${CF_SCRIPT_FORMAT:-es-module}"
CF_ENV_VARS="${CF_ENV_VARS:-[]}"

log_ok()   { echo "[OK] $1"; }
log_err()  { echo "[ERR] $1"; }
log_info() { echo "[INFO] $1"; }

check_syntax() {
  if [ ! -f "$WORKER_FILE" ]; then
    log_err "文件不存在：$WORKER_FILE"
    return 1
  fi
  if [ "$CF_SKIP_CHECK" = "true" ]; then
    log_info "已跳过语法检查（CF_SKIP_CHECK=true）"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    log_info "未安装 node，跳过语法检查"
    return 0
  fi
  log_info "语法检查：$WORKER_FILE"
  if node --check "$WORKER_FILE" 2>&1; then
    log_ok "语法通过"
    return 0
  else
    log_err "语法错误，已中止"
    return 1
  fi
}

backup_worker() {
  mkdir -p "$BACKUP_DIR"
  local ts=$(date +%Y%m%d_%H%M%S)
  cp "$WORKER_FILE" "${BACKUP_DIR}/worker_${ts}.js"
  log_ok "已备份到 ${BACKUP_DIR}/worker_${ts}.js"
}

deploy_worker() {
  log_info "上传到 Cloudflare Worker: $CF_WORKER_NAME（格式：$CF_SCRIPT_FORMAT）"
  local response
  if [ "$CF_SCRIPT_FORMAT" = "service-worker" ]; then
    local extra_bindings=""
    if [ -n "$CF_ENV_VARS" ] && [ "$CF_ENV_VARS" != "[]" ]; then
      extra_bindings=$(echo "$CF_ENV_VARS" | node -e "
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
  try {
    const arr = JSON.parse(d);
    if (!Array.isArray(arr)) { process.stdout.write(''); return; }
    const out = arr.filter(v => v && v.name && v.name !== 'CONFIG_KV').map(v => ({
      type: v.secret ? 'secret_text' : 'plain_text',
      name: String(v.name),
      text: String(v.value == null ? '' : v.value)
    }));
    if (out.length === 0) { process.stdout.write(''); return; }
    process.stdout.write(',' + out.map(x => JSON.stringify(x)).join(','));
  } catch (e) { process.stdout.write(''); }
});
" 2>/dev/null)
    fi
    local metadata="{\"body_part\":\"script\",\"compatibility_date\":\"2024-01-01\",\"bindings\":[{\"type\":\"kv_namespace\",\"name\":\"${CF_KV_BINDING}\",\"namespace_id\":\"${CF_KV_ID}\"}${extra_bindings}]}"
    response=$(curl --http1.1 -s -X PUT \
      "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${CF_WORKER_NAME}" \
      -H "Authorization: Bearer ${CF_TOKEN}" \
      -F "metadata=${metadata};type=application/json" \
      -F "script=@${WORKER_FILE};type=application/javascript")
  else
    local extra_bindings=""
    if [ -n "$CF_ENV_VARS" ] && [ "$CF_ENV_VARS" != "[]" ]; then
      extra_bindings=$(echo "$CF_ENV_VARS" | node -e "
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
  try {
    const arr = JSON.parse(d);
    if (!Array.isArray(arr)) { process.stdout.write(''); return; }
    const out = arr.filter(v => v && v.name && v.name !== 'CONFIG_KV').map(v => ({
      type: v.secret ? 'secret_text' : 'plain_text',
      name: String(v.name),
      text: String(v.value == null ? '' : v.value)
    }));
    if (out.length === 0) { process.stdout.write(''); return; }
    process.stdout.write(',' + out.map(x => JSON.stringify(x)).join(','));
  } catch (e) { process.stdout.write(''); }
});
" 2>/dev/null)
    fi
    local metadata="{\"main_module\":\"worker.js\",\"compatibility_date\":\"2024-01-01\",\"bindings\":[{\"type\":\"kv_namespace\",\"name\":\"${CF_KV_BINDING}\",\"namespace_id\":\"${CF_KV_ID}\"}${extra_bindings}]}"
    response=$(curl --http1.1 -s -X PUT \
      "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${CF_WORKER_NAME}" \
      -H "Authorization: Bearer ${CF_TOKEN}" \
      -F "metadata=${metadata};type=application/json" \
      -F "worker.js=@${WORKER_FILE};type=application/javascript+module")
  fi
  if echo "$response" | grep -q '"success": *true'; then
    log_ok "上传成功"
    return 0
  else
    log_err "上传失败"
    echo "$response"
    return 1
  fi
}

verify_deploy() {
  if [ "$CF_SKIP_VERIFY" = "true" ]; then
    log_info "已跳过访问验证（CF_SKIP_VERIFY=true）"
    return 0
  fi
  if [ -z "$CF_PUBLIC_BASE" ]; then
    log_info "未配置公开域名，跳过验证"
    return 0
  fi
  log_info "验证：访问 $CF_PUBLIC_BASE"
  local code
  code=$(curl --http1.1 -s -o /dev/null -w "%{http_code}" "${CF_PUBLIC_BASE}/" 2>/dev/null)
  if [ "$code" = "200" ] || [ "$code" = "302" ] || [ "$code" = "401" ] || [ "$code" = "404" ] || [ "$code" = "522" ]; then
    log_ok "Worker 响应（HTTP $code，视为上传成功）"
    return 0
  else
    log_err "Worker 响应异常（HTTP $code）"
    return 1
  fi
}

full_deploy() {
  echo ""
  log_info "===== 开始部署：$CF_WORKER_NAME ====="
  check_syntax || return 1
  backup_worker
  deploy_worker || return 1
  verify_deploy || return 1
  log_info "===== 完成 ====="
  echo ""
}

if [ "$1" = "--auto" ]; then
  full_deploy
elif [ "$1" = "--check" ]; then
  check_syntax
else
  full_deploy
fi
