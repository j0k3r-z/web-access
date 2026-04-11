#!/usr/bin/env node
// CDP Proxy - Extension-only mode
// 通过 CDP Bridge Extension 的 WebSocket 连接操控用户日常 Chrome
// Node.js 22+（ws 模块用于 WebSocket Server）

import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';

const PORT = parseInt(process.env.CDP_PROXY_PORT || '3456');

// --- Extension WebSocket ---
let extensionWs = null;
const extensionPending = new Map();
let extensionCmdId = 0;
let extensionWss = null;

try {
  const { WebSocketServer } = await import('ws');
  extensionWss = new WebSocketServer({ noServer: true });
} catch {
  console.error('[CDP Proxy] ws 模块未安装。执行: cd scripts && npm install ws');
  process.exit(1);
}

function useExtension() {
  return extensionWs?.readyState === 1;
}

function sendViaExtension(action, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!useExtension()) return reject(new Error('Extension not connected'));
    const id = ++extensionCmdId;
    const timer = setTimeout(() => {
      extensionPending.delete(id);
      reject(new Error('Extension command timeout: ' + action));
    }, 30000);
    extensionPending.set(id, { resolve, reject, timer });
    extensionWs.send(JSON.stringify({ id, action, ...payload }));
  });
}

// --- 读取 POST body ---
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// --- HTTP API ---
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // /health 不需要 Extension 连接
    if (pathname === '/health') {
      const connected = useExtension();
      res.end(JSON.stringify({ status: 'ok', mode: 'extension', connected }));
      return;
    }

    // Extension 连接检查
    if (!useExtension()) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'CDP Bridge Extension 未连接。请确保已安装并启用扩展。' }));
      return;
    }

    // GET /targets - 列出所有页面
    if (pathname === '/targets') {
      const resp = await sendViaExtension('targets');
      res.end(JSON.stringify(resp.result, null, 2));
    }

    // GET /new?url=xxx - 创建新后台 tab
    else if (pathname === '/new') {
      const targetUrl = q.url || 'about:blank';
      const resp = await sendViaExtension('new', { url: targetUrl });
      res.end(JSON.stringify(resp.result));
    }

    // GET /close?target=xxx - 关闭 tab
    else if (pathname === '/close') {
      const resp = await sendViaExtension('close', { targetId: q.target });
      res.end(JSON.stringify(resp.result));
    }

    // GET /navigate?target=xxx&url=yyy - 导航（自动等待加载）
    else if (pathname === '/navigate') {
      const resp = await sendViaExtension('navigate', { targetId: q.target, url: q.url });
      res.end(JSON.stringify(resp.result));
    }

    // GET /back?target=xxx - 后退
    else if (pathname === '/back') {
      const resp = await sendViaExtension('back', { targetId: q.target });
      res.end(JSON.stringify(resp.result));
    }

    // POST /eval?target=xxx - 执行 JS
    else if (pathname === '/eval') {
      const body = await readBody(req);
      const expr = body || q.expr || 'document.title';
      const resp = await sendViaExtension('cdp', {
        targetId: q.target,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true },
      });
      if (resp.result?.result?.value !== undefined) {
        res.end(JSON.stringify({ value: resp.result.result.value }));
      } else if (resp.result?.exceptionDetails) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: resp.result.exceptionDetails.text }));
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /click?target=xxx -- JS el.click()
    else if (pathname === '/click') {
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const resp = await sendViaExtension('cdp', {
        targetId: q.target,
        method: 'Runtime.evaluate',
        params: { expression: js, returnByValue: true, awaitPromise: true },
      });
      if (resp.result?.result?.value) {
        const val = resp.result.result.value;
        if (val.error) { res.statusCode = 400; }
        res.end(JSON.stringify(val));
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /clickAt?target=xxx -- CDP 真实鼠标点击
    else if (pathname === '/clickAt') {
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const resp = await sendViaExtension('clickAt', { targetId: q.target, selector });
      if (resp.result?.error) res.statusCode = 400;
      res.end(JSON.stringify(resp.result));
    }

    // POST /setFiles?target=xxx -- 给 file input 设置本地文件
    else if (pathname === '/setFiles') {
      const body = JSON.parse(await readBody(req));
      if (!body.selector || !body.files) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 selector 和 files 字段' }));
        return;
      }
      const resp = await sendViaExtension('setFiles', {
        targetId: q.target, selector: body.selector, files: body.files,
      });
      res.end(JSON.stringify(resp.result));
    }

    // GET /scroll?target=xxx&y=3000 - 滚动
    else if (pathname === '/scroll') {
      const y = parseInt(q.y || '3000');
      const direction = q.direction || 'down';
      let js;
      if (direction === 'top') {
        js = 'window.scrollTo(0, 0); "scrolled to top"';
      } else if (direction === 'bottom') {
        js = 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"';
      } else if (direction === 'up') {
        js = `window.scrollBy(0, -${Math.abs(y)}); "scrolled up ${Math.abs(y)}px"`;
      } else {
        js = `window.scrollBy(0, ${Math.abs(y)}); "scrolled down ${Math.abs(y)}px"`;
      }
      const resp = await sendViaExtension('cdp', {
        targetId: q.target,
        method: 'Runtime.evaluate',
        params: { expression: js, returnByValue: true },
      });
      await new Promise(r => setTimeout(r, 800));
      res.end(JSON.stringify({ value: resp.result?.result?.value }));
    }

    // GET /screenshot?target=xxx&file=/tmp/x.png - 截图
    else if (pathname === '/screenshot') {
      const format = q.format || 'png';
      const resp = await sendViaExtension('cdp', {
        targetId: q.target,
        method: 'Page.captureScreenshot',
        params: { format, quality: format === 'jpeg' ? 80 : undefined },
      });
      if (q.file) {
        fs.writeFileSync(q.file, Buffer.from(resp.result.data, 'base64'));
        res.end(JSON.stringify({ saved: q.file }));
      } else {
        res.setHeader('Content-Type', 'image/' + format);
        res.end(Buffer.from(resp.result.data, 'base64'));
      }
    }

    // GET /info?target=xxx - 获取页面信息
    else if (pathname === '/info') {
      const resp = await sendViaExtension('cdp', {
        targetId: q.target,
        method: 'Runtime.evaluate',
        params: {
          expression: 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})',
          returnByValue: true,
        },
      });
      res.end(resp.result?.result?.value || '{}');
    }

    else {
      res.statusCode = 404;
      res.end(JSON.stringify({
        error: '未知端点',
        endpoints: {
          '/health': 'GET - 健康检查',
          '/targets': 'GET - 列出所有页面 tab',
          '/new?url=': 'GET - 创建新后台 tab（自动等待加载）',
          '/close?target=': 'GET - 关闭 tab',
          '/navigate?target=&url=': 'GET - 导航（自动等待加载）',
          '/back?target=': 'GET - 后退',
          '/info?target=': 'GET - 页面标题/URL/状态',
          '/eval?target=': 'POST body=JS表达式 - 执行 JS',
          '/click?target=': 'POST body=CSS选择器 - 点击元素',
          '/clickAt?target=': 'POST body=CSS选择器 - 真实鼠标点击',
          '/setFiles?target=': 'POST body=JSON - 设置文件',
          '/scroll?target=&y=&direction=': 'GET - 滚动页面',
          '/screenshot?target=&file=': 'GET - 截图',
        },
      }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

// --- Extension WebSocket upgrade ---
server.on('upgrade', (req, socket, head) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  if (parsed.pathname !== '/extension') {
    socket.destroy();
    return;
  }

  extensionWss.handleUpgrade(req, socket, head, (ws) => {
    extensionWs = ws;
    console.log('[CDP Proxy] Extension connected');
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (msg.id && extensionPending.has(msg.id)) {
        const { resolve, reject, timer } = extensionPending.get(msg.id);
        clearTimeout(timer);
        extensionPending.delete(msg.id);
        if (msg.error) { reject(new Error(msg.error)); } else { resolve({ result: msg.result }); }
      }
    });
    ws.on('close', () => {
      console.log('[CDP Proxy] Extension disconnected');
      if (extensionWs === ws) extensionWs = null;
      for (const [, { reject, timer }] of extensionPending) { clearTimeout(timer); reject(new Error('Extension disconnected')); }
      extensionPending.clear();
    });
  });
});

// --- 启动 ---
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  const available = await checkPortAvailable(PORT);
  if (!available) {
    try {
      const ok = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 2000 }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(d.includes('"ok"')));
        }).on('error', () => resolve(false));
      });
      if (ok) {
        console.log(`[CDP Proxy] 已有实例运行在端口 ${PORT}，退出`);
        process.exit(0);
      }
    } catch {}
    console.error(`[CDP Proxy] 端口 ${PORT} 已被占用`);
    process.exit(1);
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[CDP Proxy] 运行在 http://127.0.0.1:${PORT} (extension-only)`);
    console.log(`[CDP Proxy] 等待 Extension 连接到 ws://localhost:${PORT}/extension`);
  });
}

process.on('uncaughtException', (e) => {
  console.error('[CDP Proxy] 未捕获异常:', e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('[CDP Proxy] 未处理拒绝:', e?.message || e);
});

main();
