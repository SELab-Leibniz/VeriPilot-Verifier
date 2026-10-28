// Isolated UI experiment: real page, RPC handlers, dispatcher and disk projection;
// only the Gateway transport is replaced. No real host or model is contacted.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { consoleFixture } from '../test/support/console-fixture.mjs';
import { registerPostRunControls } from '../lib/openclaw/post-run-controls.mjs';
import { createPostRunDispatcher } from '../lib/openclaw/post-run-dispatch.mjs';

const { chromium } = await import(process.env.RC_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.RC_PLAYWRIGHT_MODULE).href : 'playwright');
const output = path.resolve('.runtime-correction/console-experiment'); await fs.mkdir(output, { recursive: true });
const fixture = await consoleFixture({ count: 2000 });
await fs.writeFile(path.join(fixture.dir, 'baseline-extraction-status.json'), JSON.stringify({ taskId: fixture.task.taskId,
  phase: 'EXTRACTING', runId: 'fixture-extraction', updatedAt: Date.now(), deadlineAt: Date.now() + 120000 }));
const manager = createPostRunDispatcher({ directoryFor: () => fixture.root, validate: async () => true,
  waitTerminal: async () => ({ status: 'ok' }), review: async () => ({ reviewStatus: 'PASS' }), sendUser: async () => {} });
await manager.started(fixture.record, 'fixture-run');
await manager.started({ ...fixture.record, sessionId: 'other', sessionKey: 'agent:main:other' }, 'other-run');
const methods = new Map(), routes = [];
registerPostRunControls({ config: {}, logger: { warn() {} }, registerGatewayMethod: (name, handler) => methods.set(name, handler),
  registerHttpRoute: route => routes.push(route) }, { postRuns: manager, postRunReady: Promise.resolve(), validatePostSession: async () => true },
{ compatibility: async () => ({ browserClient: 'console-fixture-client.mjs', version: 'isolated-experiment' }) });
let delayed = false;
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/assets/console-fixture-client.mjs') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(`export class t {
        constructor(options){this.options=options} start(){this.options.onHello()} stop(){}
        async request(method,params){const r=await fetch('/fixture-rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});const result=await r.json();if(!result.ok)throw new Error(result.error.message);return result.value}
      }`); return;
    }
    if (req.url === '/fixture-rpc') {
      let text = ''; for await (const chunk of req) text += chunk;
      const { method, params } = JSON.parse(text);
      if (delayed && method.endsWith('.observations') && params.sessionId === 'demo') await new Promise(resolve => setTimeout(resolve, 600));
      await methods.get(method)({ params, client: { connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } },
        respond(ok, value, error) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok, value, error })); } }); return;
    }
    await routes[0].handler(req, res);
  } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
const errors = [];
const checks = [];
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function waitCount(text) { await page.waitForFunction(expected => document.getElementById('obs-count').textContent.includes(expected), text); }
try {
  browser = await chromium.launch({ headless: true, channel: process.env.RC_BROWSER_CHANNEL ?? 'msedge' });
  page = await browser.newPage({ viewport: { width: 1440, height: 1060 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/plugins/runtime-corrector/?session=agent:main:demo`);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await waitCount('共 2004 条');
  await check('current extraction phase is visible without certifying baseline publication', async () => {
    await page.locator('#obs-baseline > summary').click();
    await page.getByText('提取阶段：整理需求', { exact: false }).waitFor();
    await page.getByText('候选完成不代表正式基线已发布或任务通过', { exact: false }).waitFor();
  });
  await check('default collapsed, paginated history with explicit feedback states', async () => {
    assert.equal(await page.locator('.observation').count(), 25);
    assert.equal(await page.locator('.observation[open]').count(), 0);
    await page.locator('.observation').filter({ hasText: '任务完成后的看护' }).locator('summary').first().click();
    await page.locator('.observation[open] .feedback-state').getByText('已生成反馈，宿主送达未确认', { exact: true }).waitFor();
    assert.equal(await page.locator('.observation[open] table tbody tr').count(), 16);
    await page.locator('.observation[open]').screenshot({ path: path.join(output, 'stop-detail.png') });
  });
  await check('search matches feedback across all pages and renders markup as text', async () => {
    await page.locator('#obs-search').fill('补充报告结论'); await waitCount('匹配 1 条');
    await page.locator('.observation summary').first().click();
    await page.getByText('请补充报告结论 <script>alert(1)</script>', { exact: true }).waitFor();
    assert.equal(await page.locator('#obs-records script').count(), 0);
  });
  await check('kind and attention filters, clear and chronological pagination', async () => {
    await page.locator('#obs-clear').click(); await waitCount('匹配 2004 条');
    await page.locator('#obs-kind').selectOption('skill'); await page.locator('#obs-attention').check(); await waitCount('匹配 1 条');
    await page.locator('#obs-clear').click(); await waitCount('匹配 2004 条');
    await page.locator('#obs-next').click(); await page.waitForFunction(() => document.getElementById('obs-page').textContent.startsWith('2 /'));
    await page.locator('#obs-order').selectOption('asc'); await page.locator('#obs-kind').selectOption('response'); await waitCount('匹配 2000 条');
    assert.match(await page.locator('.observation').first().textContent(), /轮次 1(?:\D|$)/u);
  });
  await check('open state and pending draft survive automatic refresh', async () => {
    await page.locator('#obs-clear').click(); await waitCount('匹配 2004 条');
    await page.locator('#obs-expand').click(); assert.equal(await page.locator('.observation[open]').count(), 25);
    await page.locator('#new-task').fill('保留我的草稿'); await page.locator('#obs-refresh').click();
    await page.waitForTimeout(700); assert.equal(await page.locator('.observation[open]').count(), 25);
    assert.equal(await page.locator('#new-task').inputValue(), '保留我的草稿');
    await page.locator('#obs-collapse').click();
  });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  await check('narrow viewport has no horizontal overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'mobile.png') });
  });
  await check('late responses cannot overwrite a different session', async () => {
    delayed = true; await page.locator('#obs-refresh').click();
    await page.locator('.session[aria-current="false"]').click();
    await page.waitForFunction(() => document.getElementById('obs-status').textContent.includes('尚无纠偏任务'));
    await page.waitForTimeout(800); assert.equal(await page.locator('.observation').count(), 0);
    assert.match(await page.locator('#identity').textContent(), /other/u);
  });
  await check('record deep link restores the selected record and opens its details', async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}/plugins/runtime-corrector/?session=agent:main:demo&record=artifact-demo`);
    await page.getByRole('button', { name: '连接', exact: true }).click(); await waitCount('匹配 1 条');
    assert.equal(await page.locator('.observation[open]').count(), 1);
    await page.locator('.observation[open] .feedback-state').getByText('已写入宿主工具结果', { exact: true }).waitFor();
  });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors, scope: 'isolated Gateway transport, production UI/RPC/disk projection', screenshots: ['desktop.png', 'mobile.png', 'stop-detail.png'] }, null, 2));
  console.log(`Evidence: ${output}`);
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); await manager.dispose(); await fixture.cleanup();
}
