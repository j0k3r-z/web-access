#!/usr/bin/env node
// 环境检查 + 确保 CDP Proxy 就绪（Extension-only mode）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);

// --- Node.js 版本检查 ---

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const version = `v${process.versions.node}`;
  if (major >= 22) {
    console.log(`node: ok (${version})`);
  } else {
    console.log(`node: warn (${version}, 建议升级到 22+)`);
  }
}

// --- HTTP JSON 请求 ---

function httpGetJson(url, timeoutMs = 3000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then(async (res) => {
      try { return JSON.parse(await res.text()); } catch { return null; }
    })
    .catch(() => null);
}

// --- CDP Proxy 启动与等待 ---

function startProxyDetached() {
  const logFile = path.join(os.tmpdir(), 'cdp-proxy.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);
}

async function ensureProxy() {
  const healthUrl = `http://127.0.0.1:${PROXY_PORT}/health`;

  // 检查已有实例
  const health = await httpGetJson(healthUrl);
  if (health?.connected) {
    console.log('proxy: ready (extension mode)');
    return true;
  }

  // 未运行则启动
  if (!health) {
    console.log('proxy: starting...');
    startProxyDetached();
    await new Promise((r) => setTimeout(r, 2000));
  } else {
    console.log('proxy: waiting for Extension...');
  }

  // 等待 Extension 连接
  for (let i = 1; i <= 15; i++) {
    const h = await httpGetJson(healthUrl, 8000);
    if (h?.connected) {
      console.log('proxy: ready (extension mode)');
      return true;
    }
    if (i === 1) {
      console.log('waiting for CDP Bridge Extension to connect...');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('connection timeout. Please ensure CDP Bridge Extension is installed and enabled in Chrome.');
  console.log(`  log: ${path.join(os.tmpdir(), 'cdp-proxy.log')}`);
  return false;
}

// --- main ---

async function main() {
  checkNode();

  const proxyOk = await ensureProxy();
  if (!proxyOk) {
    process.exit(1);
  }

  // 列出已有站点经验
  const patternsDir = path.join(ROOT, 'references', 'site-patterns');
  try {
    const sites = fs.readdirSync(patternsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
    if (sites.length) {
      console.log(`\nsite-patterns: ${sites.join(', ')}`);
    }
  } catch {}
}

await main();
