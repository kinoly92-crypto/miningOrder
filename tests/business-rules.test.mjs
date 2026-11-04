import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import * as XLSX from 'xlsx';

test('pending, revoked, export and sequential deletion rules', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'order-record-rules-'));
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const password = randomBytes(24).toString('hex');
  const adminPassword = randomBytes(24).toString('hex');
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, NODE_ENV: 'production', DB_CLIENT: 'sqlite', ORDER_RECORD_DATA_DIR: dir,
      ORDER_RECORD_INITIAL_PASSWORD: password, ORDER_RECORD_INITIAL_ADMIN_PASSWORD: adminPassword,
      JWT_SECRET: randomBytes(32).toString('hex'), HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (data) => { output += data; });
  server.stderr.on('data', (data) => { output += data; });
  const base = `http://127.0.0.1:${port}`;
  async function request(url, token, body, method = body === undefined ? 'GET' : 'POST') {
    return fetch(base + url, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function login(username, secret) {
    const response = await request('/api/auth/login', null, { username, password: secret });
    assert.equal(response.status, 200);
    return (await response.json()).data.token;
  }
  async function data(url, token, body, method) {
    const response = await request(url, token, body, method);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).data;
  }
  const projectInput = (name) => ({ project: { projectName: name, projectType: '资产评估报告' } });
  const deleteBody = (p) => ({
    id: p.id, expectedCode: p.projectCode, expectedUpdatedAt: p.updatedAt,
    expectedDispatches: p.dispatches.map((d) => ({ id: d.id, updatedAt: d.updatedAt })), password: adminPassword,
  });

  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try {
        if ((await request('/api/projects')).status === 401) { ready = true; break; }
      } catch { /* Server is starting. */ }
      await delay(100);
    }
    assert.ok(ready, output);
    const director = await login('zhoulh', password);
    const admin = await login('sysadmin', adminPassword);

    const pending = await data('/api/dispatches', director, projectInput('Pending rule project'));
    assert.equal(pending.status, 'pending');
    assert.equal(pending.dispatches.length, 0);
    assert.equal((await request('/api/dispatches', director, { ...projectInput('Partial'), dispatch: { deptId: 1 } })).status, 400);
    assert.equal((await request('/api/dispatches', director, { ...projectInput('Multiple'), dispatch: { deptId: 1, assignee: '张三、李四' } })).status, 400);
    assert.equal((await request('/api/dispatches', director, { ...projectInput('Multiple'), dispatch: { deptId: 1, assignee: '张三 李四' } })).status, 400);
    assert.equal((await request('/api/dispatches', director, { projectId: pending.id })).status, 400);
    assert.equal((await request('/api/dispatches', director, { project: { ...projectInput('Duplicate').project, projectCode: pending.projectCode } })).status, 409);

    const assigned = await data('/api/dispatches', director, { projectId: pending.id, dispatch: { deptId: 1, assignee: '张三' } });
    assert.equal(assigned.status, 'dispatched');
    const record = assigned.dispatches[0];
    await data(`/api/dispatches/${record.id}`, director, { status: 'terminated', expectedUpdatedAt: record.updatedAt }, 'PATCH');
    let current = (await data('/api/projects', director)).find((p) => p.id === pending.id);
    assert.equal(current.status, 'terminated');
    const stats = await data('/api/stats', director);
    assert.ok(stats.terminatedProjects >= 1);

    const allExport = await request('/api/ledger/export?includeRevoked=true', director);
    const activeExport = await request('/api/ledger/export?includeRevoked=false', director);
    const readRows = async (response, name) => {
      assert.equal(response.status, 200);
      const book = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer' });
      return XLSX.utils.sheet_to_json(book.Sheets[name]);
    };
    assert.ok((await readRows(allExport, '项目台账')).some((r) => r['派单单号'] === pending.projectCode));
    assert.ok(!(await readRows(activeExport, '项目台账')).some((r) => r['派单单号'] === pending.projectCode));

    assert.equal((await request(`/api/projects/${pending.id}/reset-pending`, director, { expectedUpdatedAt: 'stale' })).status, 409);
    await data(`/api/projects/${pending.id}/reset-pending`, director, { expectedUpdatedAt: current.updatedAt });
    current = (await data('/api/projects', director)).find((p) => p.id === pending.id);
    assert.equal(current.status, 'pending');
    assert.equal(current.dispatches[0].status, 'terminated');
    const later = await data('/api/dispatches', director, projectInput('Next numbered project'));
    await data(`/api/projects/${later.id}/revoke-pending`, director, { expectedUpdatedAt: later.updatedAt });
    let laterCurrent = (await data('/api/projects', director)).find((p) => p.id === later.id);
    assert.equal(laterCurrent.status, 'terminated');
    await data(`/api/projects/${later.id}/reset-pending`, director, { expectedUpdatedAt: laterCurrent.updatedAt });
    laterCurrent = (await data('/api/projects', director)).find((p) => p.id === later.id);
    assert.equal(laterCurrent.status, 'pending');
    assert.equal((await request('/api/admin/projects/delete', admin, deleteBody(current))).status, 409);
    assert.equal((await request('/api/admin/projects/delete', director, deleteBody(laterCurrent))).status, 403);
    assert.equal((await request('/api/admin/projects/delete', admin, deleteBody(laterCurrent))).status, 200);
    assert.equal((await request('/api/admin/projects/delete', admin, deleteBody(current))).status, 200);

    const created = await data('/api/dispatches', director, {
      project: { ...projectInput('Contact and teams').project, clientContact: '李先生', clientPhone: '010-12345678' },
      dispatch: { deptId: 1, assignee: '张三', teamMembers: '王五；赵六', signatoryOne: '张三', signatoryTwo: '李四' },
    });
    assert.equal(created.clientContact, '李先生');
    assert.equal(created.clientPhone, '010-12345678');
    assert.equal(created.dispatches[0].teamMembers, '王五；赵六');
    assert.equal(created.dispatches[0].signatoryOne, '张三');
    const withSecond = await data('/api/dispatches', director, {
      projectId: created.id,
      dispatch: { deptId: 2, assignee: '李四', teamMembers: '陈七', signatoryOne: '赵六' },
    });
    assert.equal(withSecond.dispatches.find((d) => d.deptId === 1).teamMembers, '王五；赵六');
    assert.equal(withSecond.dispatches.find((d) => d.deptId === 2).teamMembers, '陈七');
    const second = withSecond.dispatches.find((d) => d.deptId === 2);
    const updated = await data(`/api/dispatches/${second.id}`, director, {
      expectedUpdatedAt: second.updatedAt, teamMembers: '陈七；周八', signatoryTwo: '孙九',
    }, 'PATCH');
    assert.equal(updated.teamMembers, '陈七；周八');
    assert.equal(updated.signatoryTwo, '孙九');
    const exportedProjects = await readRows(await request('/api/ledger/export', director), '项目台账');
    const exportedDispatches = await readRows(await request('/api/ledger/export', director), '派单记录');
    assert.equal(exportedProjects.find((r) => r['派单单号'] === created.projectCode)['委托方联系人'], '李先生');
    const exportedSecond = exportedDispatches.find((r) => r['派单单号'] === created.projectCode && r['主要承接部门'] === '业务2部');
    assert.equal(exportedSecond['委托方联系电话'], '010-12345678');
    assert.equal(exportedSecond['项目组成员'], '陈七；周八');
    assert.equal(exportedSecond['签字评估师二'], '孙九');

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
      派单项目名称: '导入联系人和成员测试', 交付成果类型: '咨询报告', 委托方联系人: '林先生',
      委托方联系电话: '020-12345678', 承接部门: '业务1部', 项目负责人: '林某',
      项目组成员: '甲；乙', 签字评估师一: '林某', 签字评估师二: '乙',
    }]), '台账导入模板');
    const form = new FormData();
    form.append('file', new Blob([XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })]), 'test.xlsx');
    const imported = await fetch(`${base}/api/ledger/import`, { method: 'POST', headers: { Authorization: `Bearer ${director}` }, body: form });
    assert.equal(imported.status, 200);
    const importResult = (await imported.json()).data;
    assert.equal(importResult.successCount, 1, JSON.stringify(importResult));
    const importedProject = (await data('/api/projects', director)).find((p) => p.projectCode === importResult.rows[0].dispatchNo);
    assert.equal(importedProject.clientContact, '林先生');
    assert.equal(importedProject.dispatches[0].teamMembers, '甲；乙');
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
