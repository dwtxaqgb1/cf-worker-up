const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '5004', 10);
const PASSWORD = process.env.WEB_PASSWORD || 'change_me';
const CF_DIR = '/app/cf';
const JS_DIR = '/app/js';
const DEPLOY_SCRIPT = path.join(CF_DIR, 'cf-deploy.sh');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SETTINGS_FILE = path.join(CF_DIR, 'settings.json');

const sessions = new Map();
const SESSION_TTL = 7 * 24 * 3600 * 1000;

function genToken() { return crypto.randomBytes(32).toString('hex'); }
function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k] = v.join('=');
  });
  return cookies;
}
function isAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.auth_token;
  if (!token) return false;
  const expire = sessions.get(token);
  if (!expire) return false;
  if (Date.now() > expire) { sessions.delete(token); return false; }
  return true;
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}
function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
  });
}

// 用 Node 原生 https 流式请求 CF KV API，避免阻塞事件循环
function cfKvRequest(accountId, token, kvId, key, res, downloadName) {
  return new Promise((resolve) => {
    const path = `/client/v4/accounts/${accountId}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(key)}`;
    const options = {
      hostname: 'api.cloudflare.com',
      port: 443,
      path: path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'cf-deployer'
      }
    };
    const req = https.request(options, (cfRes) => {
      if (cfRes.statusCode !== 200) {
        let errBody = '';
        cfRes.on('data', c => errBody += c);
        cfRes.on('end', () => {
          res.writeHead(cfRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: `KV 请求失败 HTTP ${cfRes.statusCode}: ${errBody.slice(0, 200)}` }));
          resolve({ success: false });
        });
        return;
      }
      if (downloadName) {
        // 下载模式：流式转发
        const safeName = downloadName.replace(/[^a-zA-Z0-9._-]/g, '_');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${safeName}"`
        });
        cfRes.pipe(res);
        cfRes.on('end', () => resolve({ success: true }));
      } else {
        // 读取模式：收集内容
        const chunks = [];
        cfRes.on('data', c => chunks.push(c));
        cfRes.on('end', () => {
          const content = Buffer.concat(chunks).toString('utf8');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, value: content }));
          resolve({ success: true });
        });
      }
    });
    req.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      resolve({ success: false });
    });
    req.end();
  });
}

function loadSettings() {
  try {
    let s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (!s.version || s.version < 2) {
      s = migrateSettings(s);
      saveSettings(s);
    }
    return s;
  } catch (e) {
    return { version: 2, accountId: '', apiToken: '', currentProject: '', projects: [] };
  }
}
function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}
function migrateSettings(old) {
  const workerName = old.workerName || 'iptv-config';
  return {
    version: 2,
    accountId: old.accountId || '',
    apiToken: old.apiToken || '',
    currentProject: workerName,
    projects: [{
      name: workerName,
      workerName: workerName,
      kvId: old.kvId || '',
      kvBinding: old.kvBinding || 'CONFIG_KV',
      workerFilePath: `/app/js/${workerName}/worker.js`,
      scriptFormat: 'es-module',
      publicBase: old.kvPublicBase || ''
    }]
  };
}
function getCurrentProject(s) {
  if (!s.projects || s.projects.length === 0) return null;
  const pool = (s.projects || []).filter(p => p.accountRef === s.currentAccount);
  if (pool.length === 0) return null;
  let p = pool.find(p => p.name === s.currentProject);
  if (!p) { p = pool[0]; s.currentProject = p.name; }
  return p;
}
function projectBackupDir(name) {
  const dir = path.join(CF_DIR, 'backup', name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function projectLogDir(name) {
  const dir = path.join(CF_DIR, 'logs', name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function appendLog(project, action, result) {
  try {
    const dir = projectLogDir(project);
    const line = JSON.stringify({ time: new Date().toISOString(), action, result }) + '\n';
    fs.appendFileSync(path.join(dir, 'deploy.log'), line);
  } catch (e) {}
}
function tailLog(project, lines) {
  try {
    const f = path.join(projectLogDir(project), 'deploy.log');
    if (!fs.existsSync(f)) return [];
    const all = fs.readFileSync(f, 'utf8').trim().split('\n');
    return all.slice(-lines).reverse();
  } catch (e) { return []; }
}

function cfApi(method, endpoint, accountId, token, body) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}${endpoint}`;
  const args = ['--http1.1', '-s', '-X', method, url, '-H', `Authorization: Bearer ${token}`];
  let tmpFile = null;
  if (body) {
    tmpFile = '/tmp/cf_api_body.json';
    fs.writeFileSync(tmpFile, typeof body === 'string' ? body : JSON.stringify(body));
    args.push('-H', 'Content-Type: application/json');
    args.push('--data-binary', `@${tmpFile}`);
  }
  try {
    const out = execSync(`curl ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (!out || !out.trim()) return { success: true, result: null };
    try { return JSON.parse(out); }
    catch (e) { return { success: false, errors: [{ message: 'CF 返回非 JSON: ' + out.slice(0, 200) }] }; }
  } finally {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

function fetchWorkerSource(accountId, token, workerName) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`;
  try {
    const out = execSync(`curl -4 --http1.1 -s "${url}" -H "Authorization: Bearer ${token}"`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (out.trim().startsWith('{') && (out.includes('"success"') || out.includes('"error"'))) {
      try {
        const parsed = JSON.parse(out);
        if (parsed.success === false) {
          return { success: false, error: JSON.stringify(parsed.errors || parsed.error) };
        }
      } catch (e) {}
    }
    if (!out || out.trim().length === 0) {
      return { success: false, error: '源码为空' };
    }
    return { success: true, content: out };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 剥离 multipart 表单头尾（如果存在）
function cleanMultipart(content) {
  if (!content) return content;
  let text = String(content).replace(/\r\n/g, '\n');
  let changed = true;
  let guard = 0;
  
  // 暴力剥离开头：包括 --boundary, Content-Disposition, Content-Type, 空行
  while (changed && guard++ < 50) {
    changed = false;
    text = text.replace(/^--[a-zA-Z0-9-]+\n/, '');
    text = text.replace(/^Content-[^\n]+\n/i, '');
    text = text.replace(/^\n/, '');
    // 如果第一行仍然是 --boundary，继续循环
    if (/^--[a-zA-Z0-9-]+/.test(text) || /^Content-/.test(text) || /^\n/.test(text)) {
      changed = true;
    }
  }
  
  // 暴力剥离结尾
  changed = true;
  guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    // 结尾可能是 \n--boundary-- 或 \n--boundary
    if (/\n--[a-zA-Z0-9-]+(--)?\s*$/.test(text)) {
      text = text.replace(/\n--[a-zA-Z0-9-]+(--)?\s*$/, '');
      changed = true;
    }
    if (/\n+$/.test(text)) {
      text = text.replace(/\n+$/, '');
      changed = true;
    }
  }
  
  return text;
}

function detectFormat(content) {
  if (/export\s+default\s*{/.test(content) || /export\s+default\s+async/.test(content)) {
    return 'es-module';
  }
  if (/addEventListener\s*\(\s*['"]fetch['"]/.test(content)) {
    return 'service-worker';
  }
  return 'es-module';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (/^\/[a-z-]+\.html$/.test(pathname)) {
    const f = path.join(PUBLIC_DIR, pathname.slice(1));
    if (fs.existsSync(f)) return sendFile(res, f, MIME['.html']);
  }

  if (pathname === '/') {
    const target = isAuthed(req) ? 'index.html' : 'login.html';
    return sendFile(res, path.join(PUBLIC_DIR, target), MIME['.html']);
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    let pwd = '';
    try { pwd = JSON.parse(body).password || ''; } catch (e) {}
    if (pwd !== PASSWORD) return sendJson(res, 401, { success: false, error: '密码错误' });
    const token = genToken();
    sessions.set(token, Date.now() + SESSION_TTL);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `auth_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`
    });
    return res.end(JSON.stringify({ success: true }));
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.auth_token) sessions.delete(cookies.auth_token);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'auth_token=; Path=/; Max-Age=0'
    });
    return res.end(JSON.stringify({ success: true }));
  }

  if (pathname.startsWith('/api/')) {
    if (!isAuthed(req)) return sendJson(res, 401, { success: false, error: '未登录' });

    if (pathname === '/api/project/list') {
      const s = loadSettings();
      const acc = getCurrentAccount(s);
      const filtered = (s.projects || []).filter(p => p.accountRef === s.currentAccount);
      let cur = s.currentProject;
      if (!filtered.find(p => p.name === cur)) {
        cur = filtered[0] ? filtered[0].name : '';
        if (cur) { s.currentProject = cur; saveSettings(s); }
      }
      return sendJson(res, 200, { success: true, current: cur, accountId: s.currentAccount, accountName: acc ? acc.name : '', projects: filtered });
    }

    if (pathname === '/api/project/switch' && req.method === 'POST') {
      const body = await readBody(req);
      let name = '';
      try { name = JSON.parse(body).name || ''; } catch (e) {}
      const s = loadSettings();
      const proj = s.projects.find(p => p.name === name && (p.accountRef === s.currentAccount));
      if (!proj) {
        return sendJson(res, 404, { success: false, error: '项目不存在或不属于当前账号' });
      }
      s.currentProject = name;
      const ca = getAccount(s, s.currentAccount);
      if (ca) ca.currentProject = name;
      saveSettings(s);
      return sendJson(res, 200, { success: true });
    }

    if (pathname === '/api/project/create' && req.method === 'POST') {
      const body = await readBody(req);
      let p = {};
      try { p = JSON.parse(body); } catch (e) {}
      const s = loadSettings();
      if (!s.accountId || !s.apiToken) {
        return sendJson(res, 400, { success: false, error: '请先在设置页填写 Account ID 和 API Token' });
      }
      const { name, workerName, kvName, kvBinding, publicBase, initialCode, remark } = p;
      if (!name || !workerName || !kvName) {
        return sendJson(res, 400, { success: false, error: '项目名、Worker 名、KV 名都不能为空' });
      }
      if (s.projects.find(pr => pr.name === name)) {
        return sendJson(res, 400, { success: false, error: '项目名已存在' });
      }
      const kvResp = cfApi('POST', '/storage/kv/namespaces', s.accountId, s.apiToken, { title: kvName });
      if (!kvResp.success) {
        return sendJson(res, 500, { success: false, error: '创建 KV 失败：' + JSON.stringify(kvResp.errors) });
      }
      const kvId = kvResp.result.id;
      const workerDir = path.join(JS_DIR, name);
      if (!fs.existsSync(workerDir)) fs.mkdirSync(workerDir, { recursive: true });
      const workerFilePath = path.join(workerDir, 'worker.js');
      const code = initialCode || 'export default {\n  async fetch(request, env) {\n    return new Response("Hello from ' + workerName + '");\n  }\n};\n';
      fs.writeFileSync(workerFilePath, code);
      const metadata = {
        main_module: 'worker.js',
        compatibility_date: '2024-01-01',
        bindings: [{ type: 'kv_namespace', name: kvBinding || 'CONFIG_KV', namespace_id: kvId }]
      };
      const uploadResult = uploadWorker(s.accountId, s.apiToken, workerName, workerFilePath, metadata, 'es-module');
      if (!uploadResult.success) {
        cfApi('DELETE', `/storage/kv/namespaces/${kvId}`, s.accountId, s.apiToken);
        return sendJson(res, 500, { success: false, error: '创建 Worker 失败：' + JSON.stringify(uploadResult.errors) });
      }
      const newProject = {
        name,
        accountRef: s.currentAccount,
        remark: remark || '',
        workerName,
        kvId,
        kvBinding: kvBinding || 'CONFIG_KV',
        workerFilePath: `/app/js/${name}/worker.js`,
        scriptFormat: 'es-module',
        publicBase: publicBase || ''
      };
      s.projects.push(newProject);
      s.currentProject = name;
      const ca = getAccount(s, s.currentAccount);
      if (ca) ca.currentProject = name;
      saveSettings(s);
      projectBackupDir(name);
      projectLogDir(name);
      return sendJson(res, 200, { success: true, project: newProject });
    }

    if (pathname === '/api/project/delete' && req.method === 'POST') {
      const body = await readBody(req);
      let name = '', deleteRemote = false;
      try { const p = JSON.parse(body); name = p.name || ''; deleteRemote = !!p.deleteRemote; } catch (e) {}
      const s = loadSettings();
      const idx = s.projects.findIndex(p => p.name === name && (p.accountRef === s.currentAccount));
      if (idx === -1) return sendJson(res, 404, { success: false, error: '项目不存在或不属于当前账号' });
      if (s.projects.length <= 1) return sendJson(res, 400, { success: false, error: '至少保留一个项目' });
      const proj = s.projects[idx];
      if (deleteRemote && s.accountId && s.apiToken) {
        try { cfApi('DELETE', `/workers/scripts/${proj.workerName}`, s.accountId, s.apiToken); } catch (e) {}
        try { cfApi('DELETE', `/storage/kv/namespaces/${proj.kvId}`, s.accountId, s.apiToken); } catch (e) {}
      }
      s.projects.splice(idx, 1);
      const ca = getAccount(s, s.currentAccount);
      const remaining = (s.projects || []).filter(p => p.accountRef === s.currentAccount);
      const newCur = remaining[0] ? remaining[0].name : '';
      if (s.currentProject === name) s.currentProject = newCur;
      if (ca) ca.currentProject = newCur;
      saveSettings(s);
      return sendJson(res, 200, { success: true });
    }

    // ==== 快速列出 Worker + KV（不查绑定，秒回）====
    if (pathname === '/api/cf/quick-list') {
      const s = loadSettings();
      if (!s.accountId || !s.apiToken) return sendJson(res, 400, { success: false, error: '未配置账号信息' });
      const wResp = cfApi('GET', '/workers/scripts', s.accountId, s.apiToken);
      if (!wResp.success) return sendJson(res, 500, { success: false, error: '列 Worker 失败：' + JSON.stringify(wResp.errors) });
      const workers = wResp.result || [];
      const kResp = cfApi('GET', '/storage/kv/namespaces?per_page=100', s.accountId, s.apiToken);
      const kvs = kResp.success ? (kResp.result || []) : [];
      const dResp = cfApi('GET', '/workers/domains', s.accountId, s.apiToken);
      const domains = dResp.success ? (dResp.result || []) : [];
      const existingProjects = (s.projects || [])
        .filter(p => p.accountRef === s.currentAccount)
        .map(p => p.name);
      const workersData = workers.map(w => ({
        name: w.id,
        customDomains: domains.filter(d => d.service === w.id).map(d => d.hostname)
      }));
      const result = {
        success: true,
        workers: workersData,
        kvs: kvs.map(k => ({ id: k.id, title: k.title })),
        existingProjects,
        accountId: s.currentAccount,
        cachedAt: Date.now()
      };
      // 写入缓存（按账号隔离）
      try {
        fs.writeFileSync(path.join(CF_DIR, 'import_cache_' + s.currentAccount + '.json'), JSON.stringify(result));
      } catch (e) {}
      return sendJson(res, 200, result);
    }

    // 读取缓存的列表
    if (pathname === '/api/cf/cached-list') {
      try {
        const cacheFile = path.join(CF_DIR, 'import_cache_' + s.currentAccount + '.json');
        if (!fs.existsSync(cacheFile)) {
          return sendJson(res, 200, { success: true, cached: false });
        }
        const raw = fs.readFileSync(cacheFile, 'utf8');
        const data = JSON.parse(raw);
        data.cached = true;
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 200, { success: true, cached: false });
      }
    }

    // ==== 查单个 Worker 的 KV 绑定（按需）====
    if (pathname === '/api/cf/worker-bindings') {
      const s = loadSettings();
      if (!s.accountId || !s.apiToken) return sendJson(res, 400, { success: false, error: '未配置账号信息' });
      const name = url.searchParams.get('name');
      if (!name) return sendJson(res, 400, { success: false, error: '缺少 name' });
      const settingsResp = cfApi('GET', `/workers/scripts/${encodeURIComponent(name)}/settings`, s.accountId, s.apiToken);
      const bindings = (settingsResp.success && settingsResp.result?.bindings ? settingsResp.result.bindings : [])
        .filter(b => b.type === 'kv_namespace')
        .map(b => ({ name: b.name, namespaceId: b.namespace_id }));
      return sendJson(res, 200, { success: true, bindings });
    }

    if (pathname === '/api/cf/import-data') {
      const s = loadSettings();
      if (!s.accountId || !s.apiToken) return sendJson(res, 400, { success: false, error: '未配置账号信息' });
      const wResp = cfApi('GET', '/workers/scripts', s.accountId, s.apiToken);
      if (!wResp.success) return sendJson(res, 500, { success: false, error: '列 Worker 失败：' + JSON.stringify(wResp.errors) });
      const workers = wResp.result || [];
      const kResp = cfApi('GET', '/storage/kv/namespaces?per_page=100', s.accountId, s.apiToken);
      const kvs = kResp.success ? (kResp.result || []) : [];
      const dResp = cfApi('GET', '/workers/domains', s.accountId, s.apiToken);
      const domains = dResp.success ? (dResp.result || []) : [];
      const workersData = workers.map(w => {
        const settingsResp = cfApi('GET', `/workers/scripts/${encodeURIComponent(w.id)}/settings`, s.accountId, s.apiToken);
        const bindings = (settingsResp.success && settingsResp.result?.bindings ? settingsResp.result.bindings : [])
          .filter(b => b.type === 'kv_namespace')
          .map(b => ({ name: b.name, namespaceId: b.namespace_id }));
        const customDomains = domains.filter(d => d.service === w.id).map(d => d.hostname);
        return { name: w.id, kvBindings: bindings, customDomains };
      });
      const existingProjects = (s.projects || [])
        .filter(p => p.accountRef === s.currentAccount)
        .map(p => p.name);
      return sendJson(res, 200, {
        success: true,
        workers: workersData,
        kvs: kvs.map(k => ({ id: k.id, title: k.title })),
        existingProjects
      });
    }

    if (pathname === '/api/cf/import' && req.method === 'POST') {
      const body = await readBody(req);
      let items = [];
      try { items = JSON.parse(body).items || []; } catch (e) {}
      const s = loadSettings();
      const imported = [];
      const skipped = [];
      for (const it of items) {
        const { workerName, projectName, kvId, kvBinding, publicBase } = it;
        if (!workerName) { skipped.push({ workerName, reason: '无 Worker 名' }); continue; }
        const finalProjectName = projectName || workerName;
        if (s.projects.find(p => p.name === finalProjectName && (p.accountRef === s.currentAccount))) {
          skipped.push({ workerName, reason: '项目已存在' });
          continue;
        }
        const fetchResult = fetchWorkerSource(s.accountId, s.apiToken, workerName);
        if (!fetchResult.success) {
          skipped.push({ workerName, reason: '拉取源码失败：' + fetchResult.error });
          continue;
        }
        const content = fetchResult.content;
        const format = detectFormat(content);
        const workerDir = path.join(JS_DIR, finalProjectName);
        if (!fs.existsSync(workerDir)) fs.mkdirSync(workerDir, { recursive: true });
        const workerFilePath = path.join(workerDir, 'worker.js');
        fs.writeFileSync(workerFilePath, content);

        let envVars = [];
        try {
          const settingsResp = cfApi('GET', `/workers/scripts/${encodeURIComponent(workerName)}/settings`, s.accountId, s.apiToken);
          const rawBindings = (settingsResp && settingsResp.success && settingsResp.result && settingsResp.result.bindings) ? settingsResp.result.bindings : [];
          for (const b of rawBindings) {
            if (!b || !b.name) continue;
            if (b.type === 'plain_text') {
              envVars.push({ name: b.name, value: b.text == null ? '' : String(b.text), secret: false });
            } else if (b.type === 'secret_text') {
              envVars.push({ name: b.name, value: '', secret: true });
            }
          }
        } catch (e) { console.error('import envVars fail:', e.message); }

        const newProject = {
          name: finalProjectName,
          accountRef: s.currentAccount,
          workerName,
          kvId: kvId || '',
          kvBinding: kvBinding || 'CONFIG_KV',
          workerFilePath: `/app/js/${finalProjectName}/worker.js`,
          scriptFormat: format,
          publicBase: publicBase || '',
          envVars: envVars
        };
        s.projects.push(newProject);
        projectBackupDir(finalProjectName);
        projectLogDir(finalProjectName);
        imported.push(newProject);
      }
      if (imported.length > 0 && !s.projects.find(p => p.name === s.currentProject)) {
        s.currentProject = imported[0].name;
      }
      saveSettings(s);
      return sendJson(res, 200, { success: true, imported, skipped });
    }

    // ==================== P1-2: 账号 CRUD API ====================
    if (pathname === '/api/accounts/list' && req.method === 'GET') {
      const s = loadSettings();
      const list = (s.accounts || []).map(a => ({
        id: a.id,
        name: a.name,
        accountId: a.accountId,
        apiTokenMasked: a.apiToken ? a.apiToken.slice(0, 8) + '***' : '',
        currentProject: a.currentProject || ''
      }));
      return sendJson(res, 200, { success: true, currentAccount: s.currentAccount, accounts: list });
    }

    if (pathname === '/api/accounts/add' && req.method === 'POST') {
      const body = await readBody(req);
      let p = {};
      try { p = JSON.parse(body); } catch (e) {}
      const s = loadSettings();
      if (!s.accounts) s.accounts = [];
      if (!p.accountId || !p.apiToken) {
        return sendJson(res, 400, { success: false, error: 'accountId 和 apiToken 不能为空' });
      }
      let n = s.accounts.length + 1;
      let newId;
      do { newId = 'acc_' + n; n++; } while (s.accounts.find(a => a.id === newId));
      const newAcc = {
        id: newId,
        name: p.name || ('账号' + (s.accounts.length + 1)),
        accountId: p.accountId,
        apiToken: p.apiToken,
        currentProject: ''
      };
      s.accounts.push(newAcc);
      saveSettings(s);
      return sendJson(res, 200, { success: true, account: { id: newAcc.id, name: newAcc.name, accountId: newAcc.accountId, apiTokenMasked: newAcc.apiToken.slice(0, 8) + '***' } });
    }

    if (pathname === '/api/accounts/update' && req.method === 'POST') {
      const body = await readBody(req);
      let p = {};
      try { p = JSON.parse(body); } catch (e) {}
      const s = loadSettings();
      const acc = (s.accounts || []).find(a => a.id === p.id);
      if (!acc) return sendJson(res, 404, { success: false, error: '账号不存在' });
      if (p.name !== undefined && p.name !== '') acc.name = p.name;
      if (p.accountId !== undefined) acc.accountId = p.accountId;
      if (p.apiToken !== undefined && p.apiToken !== '') acc.apiToken = p.apiToken;
      saveSettings(s);
      return sendJson(res, 200, { success: true });
    }

    if (pathname === '/api/accounts/delete' && req.method === 'POST') {
      const body = await readBody(req);
      let p = {};
      try { p = JSON.parse(body); } catch (e) {}
      const s = loadSettings();
      if (!s.accounts || s.accounts.length <= 1) {
        return sendJson(res, 400, { success: false, error: '至少保留一个账号' });
      }
      const idx = s.accounts.findIndex(a => a.id === p.id);
      if (idx === -1) return sendJson(res, 404, { success: false, error: '账号不存在' });
      const hasProjects = (s.projects || []).some(pr => pr.accountRef === p.id);
      if (hasProjects) {
        return sendJson(res, 400, { success: false, error: '该账号下还有项目，请先删除或转移' });
      }
      s.accounts.splice(idx, 1);
      if (s.currentAccount === p.id) s.currentAccount = s.accounts[0].id;
      saveSettings(s);
      return sendJson(res, 200, { success: true, currentAccount: s.currentAccount });
    }

    if (pathname === '/api/accounts/switch' && req.method === 'POST') {
      const body = await readBody(req);
      let p = {};
      try { p = JSON.parse(body); } catch (e) {}
      const s = loadSettings();
      const acc = (s.accounts || []).find(a => a.id === p.id);
      if (!acc) return sendJson(res, 404, { success: false, error: '账号不存在' });
      s.currentAccount = acc.id;
      const pool = (s.projects || []).filter(p => p.accountRef === acc.id);
      const valid = acc.currentProject && pool.find(p => p.name === acc.currentProject);
      const newCur = valid ? acc.currentProject : (pool[0] ? pool[0].name : '');
      acc.currentProject = newCur;
      s.currentProject = newCur;
      saveSettings(s);
      return sendJson(res, 200, { success: true, currentAccount: acc.id, currentProject: newCur });
    }

    if (pathname === '/api/accounts/test' && req.method === 'POST') {
      const body = await readBody(req);
      let p = {};
      try { p = JSON.parse(body); } catch (e) {}
      let token = p.apiToken;
      if (!token && p.id) {
        const s = loadSettings();
        const acc = (s.accounts || []).find(a => a.id === p.id);
        if (acc) token = acc.apiToken;
      }
      if (!token) return sendJson(res, 400, { success: false, error: 'Token 为空' });
      try {
        const out = execSync(`curl -4 --http1.1 -s -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json"`, { encoding: 'utf8' });
        const data = JSON.parse(out);
        return sendJson(res, 200, { success: data.success, result: data.result, error: data.errors && data.errors[0] && data.errors[0].message });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }
    // ==================== P1-2 end ====================

    if (pathname === '/api/global-settings' && req.method === 'GET') {
      const s = loadSettings();
      return sendJson(res, 200, {
        success: true,
        accountId: s.accountId,
        apiTokenMasked: s.apiToken ? s.apiToken.slice(0, 8) + '***' : ''
      });
    }
    if (pathname === '/api/global-settings' && req.method === 'POST') {
      const body = await readBody(req);
      let incoming = {};
      try { incoming = JSON.parse(body); } catch (e) {}
      const s = loadSettings();
      if (incoming.accountId !== undefined) s.accountId = incoming.accountId;
      if (incoming.apiToken !== undefined && incoming.apiToken !== '') s.apiToken = incoming.apiToken;
      saveSettings(s);
      return sendJson(res, 200, { success: true });
    }

    if (pathname === '/api/project-settings' && req.method === 'GET') {
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });
      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      return sendJson(res, 200, { success: true, project: p });
    }
    if (pathname === '/api/project-settings' && req.method === 'POST') {
      const body = await readBody(req);
      let incoming = {};
      try { incoming = JSON.parse(body); } catch (e) {}
      const s = loadSettings();
      const p = getCurrentProject(s);
      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      // ==== 改名处理 ====
      if (incoming.name !== undefined) {
        const newName = String(incoming.name).trim();
        if (!newName) return sendJson(res, 400, { success: false, error: '项目名不能为空' });
        if (/[\\/:*?"<>|]/.test(newName)) return sendJson(res, 400, { success: false, error: '项目名不能包含 \\ / : * ? " < > |' });
        if (newName !== p.name) {
          const dup = (s.projects || []).find(x => x.name === newName && x.accountRef === s.currentAccount);
          if (dup) return sendJson(res, 400, { success: false, error: '当前账号下已有同名项目' });
          const oldName = p.name;
          const dirs = ['/app/js', '/app/cf/backup', '/app/cf/logs'];
          for (const base of dirs) {
            const oldDir = path.join(base, oldName);
            const newDir = path.join(base, newName);
            try {
              if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
                fs.renameSync(oldDir, newDir);
              } else if (!fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
                fs.mkdirSync(newDir, { recursive: true });
              }
            } catch (e) { console.error('rename dir fail:', base, e.message); }
          }
          if (p.workerFilePath && p.workerFilePath.indexOf('/' + oldName + '/') !== -1) {
            p.workerFilePath = p.workerFilePath.replace('/' + oldName + '/', '/' + newName + '/');
          }
          p.name = newName;
          if (s.currentProject === oldName) s.currentProject = newName;
          const ca = getAccount(s, s.currentAccount);
          if (ca && ca.currentProject === oldName) ca.currentProject = newName;
        }
      }

      // workerName 禁止修改
      for (const k of ['kvId', 'kvBinding', 'workerFilePath', 'publicBase', 'scriptFormat']) {
        if (incoming[k] !== undefined) p[k] = incoming[k];
      }
      if (incoming.envVars !== undefined) {
        if (!Array.isArray(incoming.envVars)) {
          return sendJson(res, 400, { success: false, error: 'envVars 必须是数组' });
        }
        const cleaned = [];
        const names = new Set();
        for (const item of incoming.envVars) {
          if (!item) continue;
          const nm = String(item.name || '').trim();
          if (!nm) continue;
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) {
            return sendJson(res, 400, { success: false, error: '环境变量名不合法：' + nm + '（需以字母或下划线开头）' });
          }
          if (names.has(nm)) {
            return sendJson(res, 400, { success: false, error: '环境变量名重复：' + nm });
          }
          if (nm === 'CONFIG_KV') {
            return sendJson(res, 400, { success: false, error: 'CONFIG_KV 是保留名，不能作为环境变量' });
          }
          names.add(nm);
          cleaned.push({
            name: nm,
            value: String(item.value == null ? '' : item.value),
            secret: !!item.secret
          });
        }
        p.envVars = cleaned;
      }
      if (p.publicBase && !/^https?:\/\//i.test(p.publicBase)) {
        p.publicBase = 'https://' + p.publicBase.replace(/^\/+/, '');
      }
      saveSettings(s);
      return sendJson(res, 200, { success: true, name: p.name });
    }

    // ==== 域名管理：列出 ====
    if (pathname === '/api/domains/list' && req.method === 'GET') {
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      if (!s.accountId || !s.apiToken) return sendJson(res, 400, { success: false, error: '未配置账号信息' });
      const workerName = url.searchParams.get('worker') || (p && p.workerName);
      if (!workerName) return sendJson(res, 400, { success: false, error: '缺少 Worker 名' });
      const r = cfApi('GET', '/workers/domains', s.accountId, s.apiToken);
      if (!r.success) return sendJson(res, 500, { success: false, error: JSON.stringify(r.errors) });
      const list = (r.result || []).filter(d => d.service === workerName);
      return sendJson(res, 200, { success: true, domains: list });
    }

    // ==== 查 zone_id ====
    if (pathname === '/api/domains/zoneid' && req.method === 'GET') {
      const s = loadSettings();
      if (!s.accountId || !s.apiToken) return sendJson(res, 400, { success: false, error: '未配置账号信息' });
      const hostname = url.searchParams.get('hostname') || '';
      if (!hostname) return sendJson(res, 400, { success: false, error: '缺少 hostname' });
      const zone = findZone(s.accountId, s.apiToken, hostname);
      if (!zone) {
        return sendJson(res, 404, { success: false, error: '未找到对应 zone，请确认域名已托管在 Cloudflare' });
      }
      return sendJson(res, 200, { success: true, zoneId: zone.id, zoneName: zone.name });
    }

    // ==== 域名管理：添加 ====
    if (pathname === '/api/domains/add' && req.method === 'POST') {
      const body = await readBody(req);
      let params = {};
      try { params = JSON.parse(body); } catch (e) {}
      const { hostname, zoneId, workerName } = params;
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      if (!s.accountId || !s.apiToken) return sendJson(res, 400, { success: false, error: '未配置账号信息' });
      if (!hostname) return sendJson(res, 400, { success: false, error: '缺少 hostname' });
      const wName = workerName || (p && p.workerName);
      if (!wName) return sendJson(res, 400, { success: false, error: '缺少 Worker 名' });
      let finalZoneId = zoneId;
      if (!finalZoneId) {
        const zone = findZone(s.accountId, s.apiToken, hostname);
        if (!zone) {
          return sendJson(res, 404, { success: false, error: '未找到 zone，请确认域名已托管在你的 Cloudflare 账号下' });
        }
        finalZoneId = zone.id;
      }
      const payload = {
        zone_id: finalZoneId,
        hostname: hostname,
        service: wName,
        environment: 'production'
      };
      const r = cfApi('PUT', '/workers/domains', s.accountId, s.apiToken, payload);
      if (!r.success) {
        const errMsg = (r.errors && r.errors[0] && r.errors[0].message) || JSON.stringify(r.errors);
        return sendJson(res, 500, { success: false, error: errMsg });
      }
      return sendJson(res, 200, { success: true, domain: r.result });
    }

    // ==== 域名管理：删除 ====
    if (pathname === '/api/domains/delete' && req.method === 'POST') {
      const body = await readBody(req);
      let id = '';
      try { id = JSON.parse(body).id || ''; } catch (e) {}
      const s = loadSettings();
      if (!s.accountId || !s.apiToken) return sendJson(res, 400, { success: false, error: '未配置账号信息' });
      if (!id) return sendJson(res, 400, { success: false, error: '缺少 id' });
      const r = cfApi('DELETE', `/workers/domains/${encodeURIComponent(id)}`, s.accountId, s.apiToken);
      if (!r.success) {
        const errMsg = (r.errors && r.errors[0] && r.errors[0].message) || JSON.stringify(r.errors);
        return sendJson(res, 500, { success: false, error: errMsg });
      }
      return sendJson(res, 200, { success: true });
    }

    if (pathname === '/api/test-token' && req.method === 'POST') {
      const body = await readBody(req);
      let token = '';
      try { token = JSON.parse(body).token || ''; } catch (e) {}
      if (!token) {
        const s = loadSettings();
        token = s.apiToken;
      }
      if (!token) return sendJson(res, 400, { success: false, error: 'Token 为空' });
      try {
        const out = execSync(`curl -4 --http1.1 -s -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json"`, { encoding: 'utf8' });
        const data = JSON.parse(out);
        return sendJson(res, 200, { success: data.success, result: data.result, error: data.errors?.[0]?.message });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }

    // ============ B1: 保存并部署（保存 + 同步域名 + 重新部署） ============
    if (pathname === '/api/save-deploy' && req.method === 'POST') {
      const body = await readBody(req);
      let incoming = {};
      try { incoming = JSON.parse(body); } catch (e) {}
      const s = loadSettings();
      const p = getCurrentProject(s);
      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      const sendOut = (text) => send({ type: 'out', text: text + '\n' });
      const sendErr = (text) => send({ type: 'err', text: text + '\n' });

      try {
        // ===== 步骤 1：保存本地配置 + 环境变量 =====
        sendOut('[1/4] 保存本地配置...');
        if (incoming.name !== undefined) {
          const newName = String(incoming.name).trim();
          if (!newName) { sendErr('项目名不能为空'); send({ type: 'done', code: 1 }); return res.end(); }
          if (/[\\/:*?"<>|]/.test(newName)) { sendErr('项目名含非法字符'); send({ type: 'done', code: 1 }); return res.end(); }
          if (newName !== p.name) {
            const dup = (s.projects || []).find(x => x.name === newName && x.accountRef === s.currentAccount);
            if (dup) { sendErr('当前账号下已有同名项目：' + newName); send({ type: 'done', code: 1 }); return res.end(); }
            const oldName = p.name;
            for (const base of ['/app/js', '/app/cf/backup', '/app/cf/logs']) {
              const od = path.join(base, oldName), nd = path.join(base, newName);
              try {
                if (fs.existsSync(od) && !fs.existsSync(nd)) fs.renameSync(od, nd);
                else if (!fs.existsSync(od) && !fs.existsSync(nd)) fs.mkdirSync(nd, { recursive: true });
              } catch (e) {}
            }
            if (p.workerFilePath && p.workerFilePath.indexOf('/' + oldName + '/') !== -1) {
              p.workerFilePath = p.workerFilePath.replace('/' + oldName + '/', '/' + newName + '/');
            }
            p.name = newName;
            if (s.currentProject === oldName) s.currentProject = newName;
            const ca0 = getAccount(s, s.currentAccount);
            if (ca0 && ca0.currentProject === oldName) ca0.currentProject = newName;
            sendOut('  项目改名：' + oldName + ' → ' + newName);
          }
        }
        for (const k of ['kvId', 'kvBinding', 'workerFilePath', 'scriptFormat']) {
          if (incoming[k] !== undefined) p[k] = incoming[k];
        }
        if (incoming.envVars !== undefined) {
          if (!Array.isArray(incoming.envVars)) { sendErr('envVars 必须是数组'); send({ type: 'done', code: 1 }); return res.end(); }
          const cleaned = []; const names = new Set();
          for (const item of incoming.envVars) {
            if (!item) continue;
            const nm = String(item.name || '').trim();
            if (!nm) continue;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) { sendErr('环境变量名不合法：' + nm); send({ type: 'done', code: 1 }); return res.end(); }
            if (names.has(nm)) { sendErr('环境变量名重复：' + nm); send({ type: 'done', code: 1 }); return res.end(); }
            if (nm === 'CONFIG_KV') { sendErr('CONFIG_KV 是保留名'); send({ type: 'done', code: 1 }); return res.end(); }
            names.add(nm);
            cleaned.push({ name: nm, value: String(item.value == null ? '' : item.value), secret: !!item.secret });
          }
          p.envVars = cleaned;
        }
        saveSettings(s);
        sendOut('  ✔ 本地配置已保存');

        // ===== 步骤 2：同步域名 =====
        sendOut('[2/4] 同步自定义域名...');
        const desired = Array.isArray(incoming.domains) ? incoming.domains.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : null;
        if (desired && s.accountId && s.apiToken) {
          const allR = cfApi('GET', '/workers/domains', s.accountId, s.apiToken);
          const current = (allR && allR.success && Array.isArray(allR.result)) ? allR.result.filter(d => d.service === p.workerName) : [];
          const currentNames = current.map(d => d.hostname);
          // 新增
          for (const hn of desired) {
            if (currentNames.indexOf(hn) !== -1) continue;
            const zone = findZone(s.accountId, s.apiToken, hn);
            if (!zone) { sendErr('  找不到 zone：' + hn); continue; }
            const r = cfApi('PUT', '/workers/domains', s.accountId, s.apiToken, {
              zone_id: zone.id, hostname: hn, service: p.workerName, environment: 'production'
            });
            if (r.success) sendOut('  ✔ 已绑定 ' + hn);
            else sendErr('  绑定失败 ' + hn + '：' + JSON.stringify(r.errors || r));
          }
          // 删除
          for (const d of current) {
            if (desired.indexOf(d.hostname) === -1) {
              const r = cfApi('DELETE', '/workers/domains/' + encodeURIComponent(d.id), s.accountId, s.apiToken);
              if (r.success) sendOut('  ✔ 已解绑 ' + d.hostname);
              else sendErr('  解绑失败 ' + d.hostname + '：' + JSON.stringify(r.errors || r));
            }
          }
        } else {
          sendOut('  跳过（未传 domains 或未配置账号）');
        }

        // ===== 步骤 3：准备部署脚本参数 =====
        sendOut('[3/4] 准备部署...');
        const deployEnv = {
          ...process.env,
          CF_PROJECT_NAME: p.name,
          CF_ACCOUNT_ID: s.accountId,
          CF_TOKEN: s.apiToken,
          CF_WORKER_NAME: p.workerName,
          CF_KV_ID: p.kvId,
          CF_KV_BINDING: p.kvBinding,
          CF_WORKER_FILE: p.workerFilePath,
          CF_SCRIPT_FORMAT: p.scriptFormat || 'es-module',
          CF_BACKUP_DIR: '/app/cf/backup/' + p.name,
          CF_LOG_DIR: '/app/cf/logs/' + p.name,
          CF_PUBLIC_BASE: p.publicBase || '',
          CF_ENV_VARS: JSON.stringify(Array.isArray(p.envVars) ? p.envVars : []),
          CF_SKIP_CHECK: 'true',
          CF_SKIP_VERIFY: 'true'
        };

        // ===== 步骤 4：执行部署 =====
        sendOut('[4/4] 重新部署 worker...');
        const child = spawn('bash', [DEPLOY_SCRIPT, '--auto'], { env: deployEnv });
        let log = '';
        child.stdout.on('data', d => { log += d.toString(); send({ type: 'out', text: d.toString() }); });
        child.stderr.on('data', d => { log += d.toString(); send({ type: 'err', text: d.toString() }); });
        child.on('close', code => {
          if (code === 0) sendOut('全部完成 ✔');
          else sendErr('部署失败，退出码 ' + code);
          send({ type: 'done', code });
          res.end();
          appendLog(p.name, 'save-deploy', { code, summary: log.slice(-500) });
        });
      } catch (e) {
        sendErr('异常：' + e.message);
        send({ type: 'done', code: 1 });
        res.end();
      }
      return;
    }

    if (pathname === '/api/deploy' || pathname === '/api/check') {
      const s = loadSettings();
      const p = getCurrentProject(s);
      if (!p) return sendJson(res, 400, { success: false, error: '无当前项目' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      const args = pathname === '/api/deploy' ? ['--auto'] : ['--check'];
      const env = {
        ...process.env,
        CF_PROJECT_NAME: p.name,
        CF_ACCOUNT_ID: s.accountId,
        CF_TOKEN: s.apiToken,
        CF_WORKER_NAME: p.workerName,
        CF_KV_ID: p.kvId,
        CF_KV_BINDING: p.kvBinding,
        CF_WORKER_FILE: p.workerFilePath,
        CF_SCRIPT_FORMAT: p.scriptFormat || 'es-module',
        CF_BACKUP_DIR: `/app/cf/backup/${p.name}`,
        CF_LOG_DIR: `/app/cf/logs/${p.name}`,
        CF_PUBLIC_BASE: p.publicBase || '',
        CF_ENV_VARS: JSON.stringify(Array.isArray(p.envVars) ? p.envVars : [])
      };
      const child = spawn('bash', [DEPLOY_SCRIPT, ...args], { env });
      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      let log = '';
      child.stdout.on('data', d => { log += d.toString(); send({ type: 'out', text: d.toString() }); });
      child.stderr.on('data', d => { log += d.toString(); send({ type: 'err', text: d.toString() }); });
      child.on('close', code => {
        send({ type: 'done', code });
        res.end();
        appendLog(p.name, pathname.replace('/api/', ''), { code, summary: log.slice(-500) });
      });
      return;
    }

    if (pathname === '/api/status') {
      const s = loadSettings();
      const p = getCurrentProject(s);
      const result = { config: { ...s, ...p, apiToken: undefined }, fileInfo: null, backups: [], envVars: (p && Array.isArray(p.envVars)) ? p.envVars.map(v => ({ name: v.name, secret: !!v.secret, hasValue: !!v.value })) : [] };
      try {
        if (p && fs.existsSync(p.workerFilePath)) {
          result.fileInfo = { size: fs.statSync(p.workerFilePath).size, path: p.workerFilePath };
        }
      } catch (e) {}
      try {
        const bd = p ? path.join(CF_DIR, 'backup', p.name) : '';
        if (bd && fs.existsSync(bd)) {
          result.backups = fs.readdirSync(bd).sort().reverse().slice(0, 10);
        }
      } catch (e) {}
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/worker-file' && req.method === 'GET') {
      const s = loadSettings();
      const p = getCurrentProject(s);
      if (!p) return sendJson(res, 400, { success: false, error: '无当前项目' });
      const fp = p.workerFilePath;
      if (!fp) return sendJson(res, 400, { success: false, error: '未配置 worker 文件路径' });
      if (!fs.existsSync(fp)) {
        return sendJson(res, 404, { success: false, error: '文件不存在：' + fp });
      }
      try {
        const content = fs.readFileSync(fp, 'utf8');
        return sendJson(res, 200, { success: true, content, path: fp, scriptFormat: p.scriptFormat || 'es-module' });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: '读取失败：' + e.message });
      }
    }

    // 只校验代码，不保存
    if (pathname === '/api/worker-check' && req.method === 'POST') {
      const body = await readBody(req);
      let content = '';
      try { content = JSON.parse(body).content || ''; } catch (e) {
        return sendJson(res, 400, { success: false, error: '请求体格式错误' });
      }
      content = cleanMultipart(content);
      content = cleanMultipart(content);
      const tmp = '/tmp/worker_check_only.js';
      fs.writeFileSync(tmp, content);
      try {
        execSync(`node --check ${tmp}`, { stdio: 'pipe' });
      } catch (e) {
        let errMsg = '语法错误';
        if (e.stderr && e.stderr.toString().trim()) {
          errMsg += '：\n' + e.stderr.toString().trim();
        } else if (e.message) {
          errMsg += '：' + e.message;
        }
        return sendJson(res, 400, { success: false, error: errMsg });
      }
      const format = detectFormat(content);
      return sendJson(res, 200, { success: true, scriptFormat: format });
    }

    if (pathname === '/api/worker-file' && req.method === 'POST') {
      const body = await readBody(req);
      let content = '';
      try { content = JSON.parse(body).content || ''; } catch (e) {
        return sendJson(res, 400, { success: false, error: '请求体格式错误' });
      }
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      content = cleanMultipart(content);
      const tmp = '/tmp/worker_check.js';
      fs.writeFileSync(tmp, content);
      try {
        execSync(`node --check ${tmp}`, { stdio: 'pipe' });
      } catch (e) {
        let errMsg = '语法错误';
        if (e.stderr && e.stderr.toString().trim()) {
          errMsg += '：\n' + e.stderr.toString().trim();
        } else if (e.message) {
          errMsg += '：' + e.message;
        }
        return sendJson(res, 400, { success: false, error: errMsg });
      }
      const newFormat = detectFormat(content);
      fs.writeFileSync(p.workerFilePath, content);
      p.scriptFormat = newFormat;
      saveSettings(s);
      return sendJson(res, 200, { success: true, scriptFormat: newFormat });
    }

    if (pathname === '/api/worker-backup' && req.method === 'POST') {
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      try {
        const bd = projectBackupDir(p.name);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `manual_${ts}.js`;
        fs.copyFileSync(p.workerFilePath, path.join(bd, backupName));
        return sendJson(res, 200, { success: true, name: backupName });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/worker-backups' && req.method === 'GET') {
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });
      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      const bd = projectBackupDir(p.name);
      const files = fs.readdirSync(bd)
        .filter(f => f.endsWith('.js'))
        .sort().reverse()
        .map(f => {
          const fp = path.join(bd, f);
          const st = fs.statSync(fp);
          return { name: f, size: st.size, time: st.mtimeMs };
        });
      return sendJson(res, 200, { success: true, backups: files });
    }

    if (pathname === '/api/worker-backup-content' && req.method === 'POST') {
      const body = await readBody(req);
      let name = '';
      try { name = JSON.parse(body).name || ''; } catch (e) {}
      if (!name || name.includes('/') || name.includes('..')) return sendJson(res, 400, { success: false, error: '非法文件名' });
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      try {
        const content = fs.readFileSync(path.join(projectBackupDir(p.name), name), 'utf8');
        return sendJson(res, 200, { success: true, content });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/worker-restore' && req.method === 'POST') {
      const body = await readBody(req);
      let name = '';
      try { name = JSON.parse(body).name || ''; } catch (e) {}
      if (!name || name.includes('/') || name.includes('..')) return sendJson(res, 400, { success: false, error: '非法文件名' });
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      try {
        const src = path.join(projectBackupDir(p.name), name);
        if (!fs.existsSync(src)) return sendJson(res, 404, { success: false, error: '备份不存在' });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(p.workerFilePath, path.join(projectBackupDir(p.name), `before_restore_${ts}.js`));
        fs.copyFileSync(src, p.workerFilePath);
        return sendJson(res, 200, { success: true });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/worker-backup-delete' && req.method === 'POST') {
      const body = await readBody(req);
      let name = '';
      try { name = JSON.parse(body).name || ''; } catch (e) {}
      if (!name || name.includes('/') || name.includes('..')) return sendJson(res, 400, { success: false, error: '非法文件名' });
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      try {
        const fp = path.join(projectBackupDir(p.name), name);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        return sendJson(res, 200, { success: true });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/worker-backup-download' && req.method === 'POST') {
      const body = await readBody(req);
      let name = '';
      try { name = JSON.parse(body).name || ''; } catch (e) {}
      if (!name || name.includes('/') || name.includes('..')) return sendJson(res, 400, { success: false, error: '非法文件名' });
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      try {
        const fp = path.join(projectBackupDir(p.name), name);
        if (!fs.existsSync(fp)) return sendJson(res, 404, { success: false, error: '备份不存在' });
        const content = fs.readFileSync(fp);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${name}"`
        });
        return res.end(content);
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/upload-worker' && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      await new Promise(r => req.on('end', r));
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      let fileContent = null;
      if (boundaryMatch) {
        const boundary = '--' + boundaryMatch[1];
        const parts = buffer.toString('binary').split(boundary);
        for (const part of parts) {
          if (!part || part === '--' || part === '\r\n') continue;
          if (/filename=|name="/i.test(part)) {
            const idx = part.indexOf('\r\n\r\n');
            if (idx !== -1) {
              let data = part.slice(idx + 4).replace(/\r\n$/, '');
              fileContent = Buffer.from(data, 'binary');
              break;
            }
          }
        }
      }
      if (!fileContent) fileContent = buffer;

      let text = fileContent.toString('utf8').replace(/\r\n/g, '\n');
      for (let i = 0; i < 20; i++) {
        let changed = false;
        if (/^--[^\n]+\n/.test(text)) { text = text.replace(/^--[^\n]+\n/, ''); changed = true; }
        if (/^Content-[^\n]+\n/i.test(text)) { text = text.replace(/^Content-[^\n]+\n/i, ''); changed = true; }
        if (/^\n/.test(text)) { text = text.substring(1); changed = true; }
        if (!changed) break;
      }
      for (let i = 0; i < 20; i++) {
        let changed = false;
        if (/\n--[^\n]+(--)?\s*$/.test(text)) { text = text.replace(/\n--[^\n]+(--)?\s*$/, ''); changed = true; }
        if (/\n+$/.test(text)) { text = text.replace(/\n+$/, ''); changed = true; }
        if (!changed) break;
      }

      const s = loadSettings();
      const p = getCurrentProject(s);
      try {
        const bd = projectBackupDir(p.name);
        if (fs.existsSync(p.workerFilePath)) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          fs.copyFileSync(p.workerFilePath, path.join(bd, 'upload_before_' + ts + '.js'));
        }
      } catch (e) {}
      fs.writeFileSync(p.workerFilePath, text);
      p.scriptFormat = detectFormat(text);
      saveSettings(s);
      return sendJson(res, 200, { success: true, size: text.length, scriptFormat: p.scriptFormat });
    }

    if (pathname === '/api/kv-list') {
      const s = loadSettings();
      const p = getCurrentProject(s);
      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });
      if (!p.kvId || !s.apiToken || !s.accountId) return sendJson(res, 400, { success: false, error: '设置不完整' });
      const r = cfApi('GET', `/storage/kv/namespaces/${p.kvId}/keys?limit=200`, s.accountId, s.apiToken);
      return sendJson(res, 200, { success: r.success, keys: r.result || [], error: r.errors?.[0]?.message });
    }

    // KV 下载（GET 版，浏览器直接下载，不经过 JS）
    if (pathname === '/api/kv-download-get' && req.method === 'GET') {
      const s = loadSettings();
      const p = getCurrentProject(s);
      if (!p || !p.kvId || !s.apiToken || !s.accountId) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('设置不完整');
      }
      const key = url.searchParams.get('key') || '';
      if (!key) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('缺少 key');
      }
      const safeName = key.replace(/[^a-zA-Z0-9._-]/g, '_') + '.txt';
      return cfKvRequest(s.accountId, s.apiToken, p.kvId, key, res, safeName);
    }

    // KV 读值 —— 改用 Node 原生 https，异步
    if (pathname === '/api/kv-get' && req.method === 'POST') {
      const body = await readBody(req);
      let key = '';
      try { key = JSON.parse(body).key || ''; } catch (e) {}
      const s = loadSettings();
      const p = getCurrentProject(s);
      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });
      if (!p.kvId || !s.apiToken || !s.accountId) {
        return sendJson(res, 400, { success: false, error: '设置不完整' });
      }
      return cfKvRequest(s.accountId, s.apiToken, p.kvId, key, res, null);
    }

    // KV 下载 —— 流式
    if (pathname === '/api/kv-download' && req.method === 'POST') {
      const body = await readBody(req);
      let key = '';
      try { key = JSON.parse(body).key || ''; } catch (e) {}
      const s = loadSettings();
      const p = getCurrentProject(s);
      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });
      if (!p.kvId || !s.apiToken || !s.accountId) {
        return sendJson(res, 400, { success: false, error: '设置不完整' });
      }
      const safeName = key.replace(/[^a-zA-Z0-9._-]/g, '_') + '.txt';
      return cfKvRequest(s.accountId, s.apiToken, p.kvId, key, res, safeName);
    }

    if (pathname === '/api/kv-put' && req.method === 'POST') {
      const body = await readBody(req);
      let key = '', value = '';
      try { const p = JSON.parse(body); key = p.key || ''; value = p.value || ''; } catch (e) {}
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });
      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      const tmpFile = '/tmp/kv_value.txt';
      fs.writeFileSync(tmpFile, value);
      try {
        const cmd = `curl -4 --http1.1 -s -X PUT "https://api.cloudflare.com/client/v4/accounts/${s.accountId}/storage/kv/namespaces/${p.kvId}/values/${encodeURIComponent(key)}" -H "Authorization: Bearer ${s.apiToken}" --data-binary @${tmpFile}`;
        const out = execSync(cmd, { encoding: 'utf8' });
        const data = JSON.parse(out);
        return sendJson(res, 200, { success: data.success, error: data.errors?.[0]?.message });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/kv-delete' && req.method === 'POST') {
      const body = await readBody(req);
      let key = '';
      try { key = JSON.parse(body).key || ''; } catch (e) {}
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      try {
        const cmd = `curl -4 --http1.1 -s -X DELETE "https://api.cloudflare.com/client/v4/accounts/${s.accountId}/storage/kv/namespaces/${p.kvId}/values/${encodeURIComponent(key)}" -H "Authorization: Bearer ${s.apiToken}"`;
        const out = execSync(cmd, { encoding: 'utf8' });
        const data = JSON.parse(out);
        return sendJson(res, 200, { success: data.success, error: data.errors?.[0]?.message });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/logs') {
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });
      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      return sendJson(res, 200, { success: true, logs: tailLog(p.name, 100) });
    }

    if (pathname === '/api/test-endpoints' && req.method === 'POST') {
      const s = loadSettings();
      const p = getCurrentProject(s);      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });
      if (!p) return sendJson(res, 400, { success: false, error: '当前账号下没有项目' });

      const base = (p.publicBase || '').replace(/\/$/, '');
      if (!base) return sendJson(res, 400, { success: false, error: '未配置公开域名' });
      const tests = [];
      for (const t of ['/all_configs.json', '/yykm.json']) {
        try {
          const out = execSync(`curl -4 --http1.1 -s -o /dev/null -w "%{http_code}" "${base}${t}"`, { encoding: 'utf8' });
          tests.push({ name: t, status: out.trim(), ok: out.trim() === '200' });
        } catch (e) {
          tests.push({ name: t, status: 'error', ok: false, error: e.message });
        }
      }
      return sendJson(res, 200, { success: true, tests });
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

// 从 hostname 逐级尝试，找到真正存在的 zone
function findZone(accountId, token, hostname) {
  const parts = hostname.split('.');
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = parts.slice(i).join('.');
    if (parts.slice(i).length < 2) continue;
    try {
      const url = 'https://api.cloudflare.com/client/v4/zones?name=' + encodeURIComponent(candidate);
      const tmpFile = '/tmp/zone_query.json';
      // 用 curl 写到文件，避免 stdout 引号问题
      const cmd = 'curl -4 --http1.1 -s -o ' + tmpFile + ' -H "Authorization: Bearer ' + token + '" "' + url + '"';
      execSync(cmd, { encoding: 'utf8' });
      const out = fs.readFileSync(tmpFile, 'utf8');
      try { fs.unlinkSync(tmpFile); } catch (e) {}
      const data = JSON.parse(out);
      if (data.success && data.result && data.result.length > 0) {
        const z = data.result[0];
        if (z.status === 'active' || z.status === 'pending') {
          return { id: z.id, name: z.name };
        }
      }
    } catch (e) {}
  }
  return null;
}

function uploadWorker(accountId, token, workerName, workerFilePath, metadata, format) {
  const metaJson = JSON.stringify(metadata);
  let cmd;
  if (format === 'service-worker') {
    const swMeta = { ...metadata };
    delete swMeta.main_module;
    swMeta.body_part = 'script';
    const swMetaJson = JSON.stringify(swMeta);
    cmd = `curl -4 --http1.1 -s -X PUT "https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}" -H "Authorization: Bearer ${token}" -F 'metadata=${swMetaJson};type=application/json' -F 'script=@${workerFilePath};type=application/javascript'`;
  } else {
    cmd = `curl -4 --http1.1 -s -X PUT "https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}" -H "Authorization: Bearer ${token}" -F 'metadata=${metaJson};type=application/json' -F 'worker.js=@${workerFilePath};type=application/javascript+module'`;
  }
  try {
    const out = execSync(cmd, { encoding: 'utf8' });
    return JSON.parse(out);
  } catch (e) {
    return { success: false, errors: [{ message: e.message }] };
  }
}

server.listen(PORT, () => {
  console.log(`CF Deployer running at http://0.0.0.0:${PORT}`);
});

// ==================== P1: 多账号支持 ====================
function migrateToV3(old) {
  if (old.version >= 3 && Array.isArray(old.accounts)) return old;
  const accId = 'acc_1';
  return {
    version: 3,
    currentAccount: accId,
    accounts: [{
      id: accId,
      name: '账号1',
      accountId: old.accountId || '',
      apiToken: old.apiToken || '',
      currentProject: old.currentProject || (old.projects && old.projects[0] && old.projects[0].name) || ''
    }],
    projects: (old.projects || []).map(p => Object.assign({}, p, { accountRef: accId }))
  };
}
function getAccount(s, id) {
  return (s.accounts || []).find(a => a.id === id) || null;
}
function getCurrentAccount(s) {
  return getAccount(s, s.currentAccount) || (s.accounts && s.accounts[0]) || null;
}
function getAccountByProject(s, projectName) {
  const p = (s.projects || []).find(x => x.name === projectName);
  if (!p) return null;
  return getAccount(s, p.accountRef);
}
function loadSettings() {
  try {
    let s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (!s.version || s.version < 2) {
      s = migrateSettings(s);
      saveSettings(s);
    }
    if (!s.version || s.version < 3 || !Array.isArray(s.accounts)) {
      s = migrateToV3(s);
      saveSettings(s);
    }
    const acc = getCurrentAccount(s);
    if (acc) {
      s.accountId = acc.accountId;
      s.apiToken = acc.apiToken;
      const pool = (s.projects || []).filter(p => p.accountRef === s.currentAccount);
      const valid = acc.currentProject && pool.find(p => p.name === acc.currentProject);
      s.currentProject = valid ? acc.currentProject : (pool[0] ? pool[0].name : '');
    }
    return s;
  } catch (e) {
    return { version: 3, currentAccount: '', accounts: [], accountId: '', apiToken: '', currentProject: '', projects: [] };
  }
}
function saveSettings(s) {
  const out = Object.assign({}, s);
  delete out.accountId;
  delete out.apiToken;
  delete out.currentProject;
  if (!out.currentAccount && out.accounts && out.accounts.length > 0) {
    out.currentAccount = out.accounts[0].id;
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(out, null, 2));
}
// ==================== P1 end ====================
