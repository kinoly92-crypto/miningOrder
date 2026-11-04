import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

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

test('only sysadmin can delete business data and clear logs', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'order-record-admin-test-'));
  const port = await availablePort();
  const password = randomBytes(24).toString('hex');
  const adminPassword = randomBytes(24).toString('hex');
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DB_CLIENT: 'sqlite',
      ORDER_RECORD_DATA_DIR: dataDir,
      ORDER_RECORD_INITIAL_PASSWORD: password,
      ORDER_RECORD_INITIAL_ADMIN_PASSWORD: adminPassword,
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

  async function request(url, token, data, method = data === undefined ? 'GET' : 'POST') {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${base}${url}`, {
      method,
      headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  }
  async function login(username, secret) {
    let response = await request('/api/auth/login', null, { username, password: secret });
    assert.equal(response.status, 200);
    let data = await response.json();
    let effectiveSecret = secret;
    if (data.data.user.mustChangePassword) {
      const token = data.data.token;
      effectiveSecret = `${secret}_new`;
      response = await request('/api/auth/account', token, { username, currentPassword: secret, newPassword: effectiveSecret }, 'PATCH');
      assert.equal(response.status, 200);
      response = await request('/api/auth/login', null, { username, password: effectiveSecret });
      assert.equal(response.status, 200);
      data = await response.json();
    }
    return { token: data.data.token, password: effectiveSecret };
  }
  async function projects(token) {
    const response = await request('/api/projects', token);
    assert.equal(response.status, 200);
    return (await response.json()).data;
  }
  async function createProject(token, name) {
    const response = await request('/api/dispatches', token, {
      project: { projectName: name, projectType: '矿业权评估报告' },
      dispatch: { deptId: 1, assignee: 'TestAssignee' },
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).data;
  }
  function projectDeleteBody(project, pass) {
    return {
      id: project.id,
      expectedCode: project.projectCode,
      expectedUpdatedAt: project.updatedAt,
      expectedDispatches: project.dispatches.map((d) => ({ id: d.id, updatedAt: d.updatedAt })),
      password: pass,
    };
  }

  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(`Server exited early: ${output}`);
      try {
        if ((await request('/api/projects', null)).status === 401) {
          ready = true;
          break;
        }
      } catch {
        // The isolated server is still starting.
      }
      await delay(100);
    }
    assert.ok(ready, `Server did not start: ${output}`);

    const adminResult = await login('sysadmin', adminPassword);
    const admin = adminResult.token;
    const adminPass = adminResult.password;
    const directorResult = await login('licl', password);
    const director = directorResult.token;
    const db = new DatabaseSync(path.join(dataDir, 'app.db'));
    try {
      db.exec("INSERT INTO admin_accounts (user_id) SELECT id FROM users WHERE username = 'yinzx'");
    } finally {
      db.close();
    }
    const otherAdminResult = await login('yinzx', password);
    const otherAdmin = otherAdminResult.token;

    const protectedPosts = [
      '/api/admin/projects/delete',
      '/api/admin/dispatches/delete',
      '/api/admin/projects/clear',
      '/api/admin/audit-logs/clear',
    ];
    for (const url of protectedPosts) {
      assert.equal((await request(url, null, {})).status, 401, url);
      for (const token of [director, otherAdmin]) {
        assert.equal((await request(url, token, { password: adminPass })).status, 403, url);
      }
    }
    for (const token of [director, otherAdmin]) {
      assert.equal((await request('/api/admin/projects/clear-preview', token)).status, 403);
    }

    const first = await createProject(director, 'Admin Delete Test');
    const dispatch = first.dispatches[0];
    const dispatchBody = { id: dispatch.id, expectedUpdatedAt: dispatch.updatedAt, password: adminPass };
    assert.equal((await request('/api/admin/dispatches/delete', admin, { ...dispatchBody, password: 'wrong' })).status, 403);
    assert.equal((await request('/api/admin/dispatches/delete', admin, { ...dispatchBody, expectedUpdatedAt: 'stale' })).status, 409);
    assert.ok((await projects(admin)).some((p) => p.id === first.id && p.dispatches.some((d) => d.id === dispatch.id)));

    const ticketResponse = await request('/api/auth/events-ticket', director, {});
    const ticket = (await ticketResponse.json()).data.ticket;
    const controller = new AbortController();
    const events = await fetch(`${base}/api/events?ticket=${ticket}`, { signal: controller.signal });
    const reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
    assert.equal((await request('/api/admin/dispatches/delete', admin, dispatchBody)).status, 200);
    const update = await Promise.race([
      reader.read(),
      delay(5000).then(() => { throw new Error('Realtime deletion update timed out'); }),
    ]);
    assert.match(new TextDecoder().decode(update.value), /event: change/);
    controller.abort();
    assert.equal((await projects(admin)).find((p) => p.id === first.id).dispatches.length, 0);

    const original = await createProject(director, 'Project Cascade Test');
    const extra = await request('/api/dispatches', director, {
      projectId: original.id,
      dispatch: { deptId: 2, assignee: 'SecondAssignee' },
    });
    assert.equal(extra.status, 200);
    assert.equal((await request('/api/admin/projects/delete', admin, projectDeleteBody(original, adminPass))).status, 409);
    const current = (await projects(admin)).find((p) => p.id === original.id);
    assert.equal(current.dispatches.length, 2);
    const projectAuditDb = new DatabaseSync(path.join(dataDir, 'app.db'));
    try {
      projectAuditDb.exec("CREATE TRIGGER fail_project_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'delete-project' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END");
      assert.equal((await request('/api/admin/projects/delete', admin, projectDeleteBody(current, adminPass))).status, 500);
      const preserved = (await projects(admin)).find((p) => p.id === original.id);
      assert.equal(preserved.dispatches.length, 2);
    } finally {
      projectAuditDb.exec('DROP TRIGGER fail_project_audit');
      projectAuditDb.close();
    }
    assert.equal((await request('/api/admin/projects/delete', admin, projectDeleteBody(current, adminPass))).status, 200);
    assert.ok(!(await projects(admin)).some((p) => p.id === original.id));
    const remainingDispatches = await request('/api/dispatches', admin);
    assert.ok(!(await remainingDispatches.json()).data.some((d) => d.projectId === original.id));

    const previewResponse = await request('/api/admin/projects/clear-preview', admin);
    const preview = (await previewResponse.json()).data;
    await createProject(director, 'Created After Preview');
    const clearBody = { revision: preview.revision, password: adminPass, confirmation: '清空全部项目' };
    assert.equal((await request('/api/admin/projects/clear', admin, clearBody)).status, 409);
    assert.ok((await projects(admin)).some((p) => p.projectName === 'Created After Preview'));
    const latest = (await (await request('/api/admin/projects/clear-preview', admin)).json()).data;
    assert.equal((await request('/api/admin/projects/clear', admin, { ...clearBody, revision: latest.revision, confirmation: 'wrong' })).status, 400);
    assert.equal((await request('/api/admin/projects/clear', admin, { ...clearBody, revision: latest.revision })).status, 200);
    assert.equal((await projects(admin)).length, 0);
    assert.equal((await request('/api/departments', admin)).status, 200);
    assert.equal((await request('/api/auth/me', director)).status, 200);

    const logsBefore = (await (await request('/api/audit-logs', admin)).json()).data;
    assert.ok(logsBefore.some((log) => log.action === 'delete-dispatch'));
    assert.ok(logsBefore.some((log) => log.action === 'delete-project'));
    assert.ok(logsBefore.some((log) => log.action === 'clear-projects'));
    assert.ok(!JSON.stringify(logsBefore).includes(adminPassword));
    assert.equal((await request('/api/admin/audit-logs/clear', admin, { password: adminPass, confirmation: 'wrong' })).status, 400);
    const clearAuditDb = new DatabaseSync(path.join(dataDir, 'app.db'));
    try {
      clearAuditDb.exec("CREATE TRIGGER fail_clear_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'clear-audit-logs' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END");
      assert.equal((await request('/api/admin/audit-logs/clear', admin, { password: adminPass, confirmation: '清空操作日志' })).status, 500);
      const preservedLogs = (await (await request('/api/audit-logs', admin)).json()).data;
      assert.equal(preservedLogs.length, logsBefore.length);
    } finally {
      clearAuditDb.exec('DROP TRIGGER fail_clear_audit');
      clearAuditDb.close();
    }
    assert.equal((await request('/api/admin/audit-logs/clear', admin, { password: adminPass, confirmation: '清空操作日志' })).status, 200);
    const logsAfter = (await (await request('/api/audit-logs', admin)).json()).data;
    assert.equal(logsAfter.length, 1);
    assert.equal(logsAfter[0].action, 'clear-audit-logs');
    assert.equal(logsAfter[0].userName, '系统管理员');

    for (let i = 0; i < 5; i++) {
      const failed = await request('/api/admin/audit-logs/clear', admin, { password: 'wrong', confirmation: '清空操作日志' });
      assert.equal(failed.status, 403);
    }
    const limited = await request('/api/admin/audit-logs/clear', admin, { password: adminPass, confirmation: '清空操作日志' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
