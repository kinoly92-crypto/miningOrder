import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { consumeRealtimeTicket, createRealtimeTicket } from '../server/src/realtime-tickets.ts';

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(base, child, output) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output()}`);
    try {
      const response = await fetch(`${base}/api/projects`);
      if (response.status === 401) return;
    } catch {
      // The isolated server is still starting.
    }
    await delay(100);
  }
  throw new Error(`Server did not start: ${output()}`);
}

test('realtime tickets expire and cannot be reused', () => {
  const originalNow = Date.now;
  try {
    let now = originalNow();
    Date.now = () => now;
    const ticket = createRealtimeTicket(12, 3);
    now += 30_001;
    assert.equal(consumeRealtimeTicket(ticket), undefined);
    const valid = createRealtimeTicket(12, 3);
    assert.equal(consumeRealtimeTicket(valid)?.userId, 12);
    assert.equal(consumeRealtimeTicket(valid), undefined);
  } finally {
    Date.now = originalNow;
  }
});

test('production refuses a missing JWT secret', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET/);
});

test('isolated authentication, one-use realtime tickets, and login throttling', { timeout: 45_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'order-record-security-'));
  const port = await availablePort();
  const password = randomBytes(24).toString('hex');
  const newPassword = randomBytes(24).toString('hex');
  const newerPassword = randomBytes(24).toString('hex');
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DB_CLIENT: 'sqlite',
      ORDER_RECORD_DATA_DIR: dataDir,
      ORDER_RECORD_INITIAL_PASSWORD: password,
      ORDER_RECORD_INITIAL_ADMIN_PASSWORD: randomBytes(24).toString('hex'),
      JWT_SECRET: randomBytes(32).toString('hex'),
      HOST: '127.0.0.1',
      PORT: String(port),
      TRUST_PROXY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    await waitForServer(base, child, () => output);
    let login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'licl', password }),
    });
    assert.equal(login.status, 200);
    let loginData = await login.json();
    if (loginData.data.user.mustChangePassword) {
      const change = await fetch(`${base}/api/auth/change-password`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loginData.data.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      assert.equal(change.status, 200);
      login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'licl', password: newPassword }),
      });
      assert.equal(login.status, 200);
      loginData = await login.json();
    }
    const token = loginData.data.token;
    const headers = { Authorization: `Bearer ${token}` };

    assert.equal((await fetch(`${base}/api/projects`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/events?token=${encodeURIComponent(token)}`)).status, 401);
    assert.equal((await fetch(`${base}/api/projects?token=${encodeURIComponent(token)}`)).status, 401);

    for (const [url, expectedSheet] of [
      ['/api/ledger/import-template', '台账导入模板'],
      ['/api/ledger/export', '项目台账'],
      ['/api/audit-logs/export', '操作日志'],
    ]) {
      const download = await fetch(`${base}${url}`, { headers });
      assert.equal(download.status, 200);
      const workbook = XLSX.read(Buffer.from(await download.arrayBuffer()), { type: 'buffer' });
      assert.ok(workbook.SheetNames.includes(expectedSheet));
    }

    for (const format of ['xlsx', 'biff8']) {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
        派单项目名称: `Excel Import ${format}`,
        交付成果类型: '矿业权评估报告',
        主要承接平台: '中和西南分公司',
        项目负责人: '测试负责人',
      }]), '台账导入模板');
      const data = XLSX.write(workbook, { type: 'buffer', bookType: format });
      const form = new FormData();
      form.append('file', new Blob([data]), `import.${format === 'biff8' ? 'xls' : 'xlsx'}`);
      const upload = await fetch(`${base}/api/ledger/import`, { method: 'POST', headers, body: form });
      assert.equal(upload.status, 200);
      const result = (await upload.json()).data;
      assert.equal(result.successCount, 1, JSON.stringify(result));
      assert.equal(result.failureCount, 0);
    }

    const ticketResponse = await fetch(`${base}/api/auth/events-ticket`, { method: 'POST', headers });
    assert.equal(ticketResponse.status, 200);
    const ticket = (await ticketResponse.json()).data.ticket;
    assert.match(ticket, /^[a-f0-9]{64}$/);
    const controller = new AbortController();
    const events = await fetch(`${base}/api/events?ticket=${ticket}`, { signal: controller.signal });
    assert.equal(events.status, 200);
    const reader = events.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: ready/);
    assert.equal((await fetch(`${base}/api/events?ticket=${ticket}`)).status, 401);

    const dispatch = await fetch(`${base}/api/dispatches`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: { projectName: 'Isolated Security Test', projectType: '矿业权评估报告' },
        dispatch: { deptId: 1, assignee: 'TestUser' },
      }),
    });
    assert.equal(dispatch.status, 200, await dispatch.text());
    const update = await Promise.race([
      reader.read(),
      delay(5000).then(() => { throw new Error('Realtime update timed out'); }),
    ]);
    assert.match(new TextDecoder().decode(update.value), /event: change/);
    controller.abort();

    const staleResponse = await fetch(`${base}/api/auth/events-ticket`, { method: 'POST', headers });
    const staleTicket = (await staleResponse.json()).data.ticket;
    const changePassword = await fetch(`${base}/api/auth/account`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'licl', currentPassword: newPassword, newPassword: newerPassword }),
    });
    assert.equal(changePassword.status, 200);
    assert.equal((await fetch(`${base}/api/events?ticket=${staleTicket}`)).status, 401);
    assert.equal((await fetch(`${base}/api/projects`, { headers })).status, 401);

    let limited;
    let throttled = false;
    for (let i = 0; i < 30; i++) {
      limited = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${i + 1}` },
        body: JSON.stringify({ username: 'no-such-user', password }),
      });
      if (throttled) {
        assert.equal(limited.status, 429);
      } else if (limited.status === 429) {
        throttled = true;
      } else {
        assert.equal(limited.status, 401);
      }
    }
    assert.ok(throttled, '应在 30 次失败登录内触发限流');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
