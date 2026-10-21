// Runs the installed, unmodified MA renderer in an isolated headless browser.
// Only Electron's transport/storage boundary is supplied by this test adapter.
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

export async function maRendererObserver({ matrixRoot, invoke, onLog = () => {} }) {
  const archive = path.join(matrixRoot, "resources/app.asar"), fd = fs.openSync(archive, "r");
  const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
  const base = 8 + prefix.readUInt32LE(4), header = Buffer.alloc(prefix.readUInt32LE(12));
  fs.readSync(fd, header, 0, header.length, 16);
  const tree = JSON.parse(header.toString("utf8"));
  function read(name) {
    let entry = tree;
    for (const part of name.split("/")) entry = entry?.files?.[part];
    if (!entry || entry.files || entry.unpacked || entry.size > 32 * 1024 * 1024) return null;
    const bytes = Buffer.alloc(entry.size);
    fs.readSync(fd, bytes, 0, bytes.length, base + Number(entry.offset));
    return bytes;
  }
  const html = read("dist/index.html").toString("utf8"), asset = html.match(/src="\.?(\/assets\/main-[^"?]+\.js)"/u)?.[1];
  if (!asset) throw new Error("Installed MA renderer entry cannot be identified");
  const source = read(`dist${asset}`), exports = source.toString("utf8").slice(-6000);
  const alias = name => {
    const value = exports.match(new RegExp(`\\b${name} as (\\w+)`))?.[1];
    if (!value) throw new Error(`Installed MA store export changed: ${name}`);
    return value;
  };
  const aliases = { chat: alias("re"), meta: alias("X"), gateway: alias("Qn"), sessions: alias("Ve") };
  const pkg = JSON.parse(read("package.json")), logs = [], calls = [];
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname).slice(1);
    if (name === "observer.html") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<div id="root"></div><script type="module">const m=await import('/dist${asset}');window.__ma=Object.fromEntries(Object.entries(${JSON.stringify(aliases)}).map(([k,v])=>[k,m[v]]));</script>`);
      return;
    }
    const bytes = read(name);
    if (!bytes) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(name);
    res.setHeader("content-type", ({ ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" })[ext] ?? "application/octet-stream");
    res.end(bytes);
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const require = createRequire(path.join(matrixRoot, "resources/openclaw/package.json"));
    const { chromium } = require("playwright-core");
    const cache = path.join(process.env.LOCALAPPDATA, "ms-playwright");
    const names = (await fsp.readdir(cache)).filter(name => name.startsWith("chromium_headless_shell-")).sort().reverse();
    let executablePath;
    for (const name of names) for (const relative of ["chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-win64/headless_shell.exe", "chrome-win/headless_shell.exe"]) {
      const file = path.join(cache, name, relative);
      if (fs.existsSync(file)) { executablePath = file; break; }
    }
    if (!executablePath) throw new Error("Existing headless Chromium runtime not found");
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    page.on("console", message => {
      const text = message.text();
      if (/idle-watchdog|agent-wait|error-bar|Failed to forward gateway notification/u.test(text)) {
        const row = { at: Date.now(), text }; logs.push(row); onLog(row);
      }
    });
    await page.exposeFunction("rcInvoke", async args => {
      if (args[0] === "gateway:rpc") calls.push({ at: Date.now(), method: args[1] });
      return invoke(...args);
    });
    await page.addInitScript(() => {
      const listeners = new Map();
      window.__maEmit = (channel, payload) => { for (const fn of listeners.get(channel) ?? []) fn(payload); };
      window.electron = {
        platform: "win32", initialMaximized: false,
        onMaximizedChanged() {}, removeMaximizedChangedListener() {},
        ipcRenderer: {
          invoke: (...args) => window.rcInvoke(args), send() {},
          on(channel, fn) {
            const set = listeners.get(channel) ?? new Set(); listeners.set(channel, set); set.add(fn);
            return () => set.delete(fn);
          },
          once(channel, fn) { const remove = this.on(channel, value => { remove(); fn(value); }); return remove; },
          removeAllListeners(channel) { listeners.delete(channel); },
        },
      };
    });
    await page.goto(`${origin}/observer.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ma?.chat && window.__ma?.gateway, { timeout: 30000 });
    await page.evaluate(() => window.__ma.gateway.getState().init());
    let queue = Promise.resolve(), closed = false;
    const deliver = event => {
      if (closed) return;
      const channel = event.event === "chat" || event.event === "session.tool" ? "gateway:chat-message"
        : event.event === "session.message" ? "gateway:session-snapshot" : "gateway:notification";
      const payload = channel === "gateway:notification" ? { method: event.event, params: event.payload } : { message: event.payload };
      queue = queue.then(() => !closed && page.evaluate(({ channel, payload }) => window.__maEmit(channel, payload), { channel, payload }));
      queue.catch(error => onLog({ at: Date.now(), text: `observer delivery failed: ${error.message}` }));
    };
    return {
      version: pkg.version, renderer: `dist${asset}`, rendererSha256: createHash("sha256").update(source).digest("hex"), logs, calls, deliver,
      async begin(sessionKey, runId, prompt) {
        await page.evaluate(({ sessionKey, runId, prompt }) => {
          window.__ma.sessions.setState({ currentSessionKey: sessionKey, currentAgentId: "main" });
          window.__ma.chat.setState({ currentSessionKey: sessionKey, currentAgentId: "main", activeRunId: runId,
            error: null, messages: [{ role: "user", content: prompt }], streamingStartTime: Date.now() });
          window.__ma.meta.getState().setMeta(sessionKey, { status: "delta", hasActiveRun: true });
        }, { sessionKey, runId, prompt });
      },
      async snapshot(sessionKey) {
        await queue;
        return page.evaluate(key => {
          const chat = window.__ma.chat.getState(), meta = window.__ma.meta.getState().getMeta(key);
          return { status: meta?.status, error: chat.error, activeRunId: chat.activeRunId,
            messageRoles: chat.messages.map(message => message.role), lastAssistant: chat.messages.filter(message => message.role === "assistant").at(-1)?.content };
        }, sessionKey);
      },
      async abort() { await page.evaluate(() => window.__ma.chat.getState().abortRun()); },
      async close() { closed = true; await queue.catch(() => {}); await browser.close(); await new Promise(resolve => server.close(resolve)); fs.closeSync(fd); },
    };
  } catch (error) {
    await browser?.close(); await new Promise(resolve => server.close(resolve)); fs.closeSync(fd); throw error;
  }
}
