import { createHash } from 'node:crypto';
import { Router, type Response } from 'express';
import { confirmAdminPassword, requireSysadmin } from '../admin-auth';
import { writeAudit } from '../audit';
import { asyncRoute } from '../async-route';
import { inTransaction } from '../errors';
import type { AuthedRequest } from '../middleware';
import { broadcastChange } from '../sse';
import { all, execute, lockDispatchCreation, one } from '../storage';

const router = Router();
router.use('/admin', requireSysadmin);

class AdminActionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function handleError(error: unknown, res: Response): void {
  if (error instanceof AdminActionError) {
    res.status(error.status).json({ success: false, error: error.message });
    return;
  }
  throw error;
}

function validId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

const forUpdate = process.env.DB_CLIENT === 'mysql' ? ' FOR UPDATE' : '';
type ProjectRow = { id: number; project_code: string; project_name: string; updated_at: string };
type DispatchRow = {
  id: number; project_id: number; dept_id: number; assignee: string;
  status: string; remark: string | null; updated_at: string;
};

async function requireLastProjectCode(code: string): Promise<void> {
  if (!/^PD\d{4}-\d{4}$/.test(code)) {
    throw new AdminActionError(409, '该项目编号不符合规则，无法永久删除');
  }
  const later = await one<{ project_code: string }>(
    'SELECT project_code FROM projects WHERE project_code LIKE ? AND project_code > ? ORDER BY project_code DESC LIMIT 1',
    [`${code.slice(0, 7)}%`, code],
  );
  if (later) throw new AdminActionError(409, `请先处理更大的编号 ${later.project_code}；该项目可选择撤销`);
}

async function projectSnapshot() {
  const projects = await all<ProjectRow>(
    `SELECT id, project_code, project_name, updated_at FROM projects ORDER BY id${forUpdate}`,
  );
  const dispatches = await all<DispatchRow>(
    `SELECT id, project_id, dept_id, assignee, status, remark, updated_at FROM dispatches ORDER BY id${forUpdate}`,
  );
  return {
    revision: createHash('sha256').update(JSON.stringify({ projects, dispatches })).digest('hex'),
    projectCount: projects.length,
    dispatchCount: dispatches.length,
  };
}

router.get('/admin/projects/clear-preview', asyncRoute(async (_req, res) => {
  const preview = await inTransaction(async () => {
    await lockDispatchCreation();
    return projectSnapshot();
  });
  res.json({ success: true, data: preview });
}));

router.post('/admin/projects/delete', confirmAdminPassword, asyncRoute(async (req: AuthedRequest, res) => {
  const { id, expectedCode, expectedUpdatedAt, expectedDispatches } = req.body ?? {};
  if (!validId(id) || typeof expectedCode !== 'string' || typeof expectedUpdatedAt !== 'string' ||
      !Array.isArray(expectedDispatches) ||
      !expectedDispatches.every((d: unknown) => {
        const item = d as { id?: unknown; updatedAt?: unknown } | null;
        return item !== null && typeof item === 'object' && validId(item.id) && typeof item.updatedAt === 'string';
      })) {
    res.status(400).json({ success: false, error: '项目信息不完整，请刷新后重试' });
    return;
  }
  try {
    await inTransaction(async () => {
      await lockDispatchCreation();
      const project = await one<ProjectRow>(
        `SELECT id, project_code, project_name, updated_at FROM projects WHERE id = ?${forUpdate}`, [id],
      );
      if (!project) throw new AdminActionError(404, '项目不存在，请刷新台账');
      const dispatches = await all<{ id: number; updated_at: string }>(
        `SELECT id, updated_at FROM dispatches WHERE project_id = ? ORDER BY id${forUpdate}`, [id],
      );
      const expected = (expectedDispatches as { id: number; updatedAt: string }[])
        .map((d) => ({ id: d.id, updated_at: d.updatedAt })).sort((a, b) => a.id - b.id);
      if (project.project_code !== expectedCode || project.updated_at !== expectedUpdatedAt ||
          JSON.stringify(dispatches) !== JSON.stringify(expected)) {
        throw new AdminActionError(409, '项目或派单已发生变化，请刷新后重新确认');
      }
      await requireLastProjectCode(project.project_code);
      await execute('DELETE FROM projects WHERE id = ?', [id]);
      await writeAudit({
        user: req.user, action: 'delete-project', targetType: 'project', targetId: id,
        detail: `永久删除 ${project.project_code}《${project.project_name}》及其 ${dispatches.length} 条派单`,
      });
    });
    broadcastChange('projects');
    res.json({ success: true });
  } catch (error) {
    handleError(error, res);
  }
}));

router.post('/admin/dispatches/delete', confirmAdminPassword, asyncRoute(async (req: AuthedRequest, res) => {
  const { id, expectedUpdatedAt } = req.body ?? {};
  if (!validId(id) || typeof expectedUpdatedAt !== 'string') {
    res.status(400).json({ success: false, error: '派单信息不完整，请刷新后重试' });
    return;
  }
  try {
    await inTransaction(async () => {
      await lockDispatchCreation();
      const dispatch = await one<DispatchRow>(
        `SELECT id, project_id, dept_id, assignee, status, remark, updated_at FROM dispatches WHERE id = ?${forUpdate}`, [id],
      );
      if (!dispatch) throw new AdminActionError(404, '派单不存在，请刷新台账');
      if (dispatch.updated_at !== expectedUpdatedAt) {
        throw new AdminActionError(409, '派单已发生变化，请刷新后重新确认');
      }
      const project = await one<{ project_code: string; project_name: string }>(
        'SELECT project_code, project_name FROM projects WHERE id = ?', [dispatch.project_id],
      );
      if (!project) throw new AdminActionError(404, '项目不存在，请刷新台账');
      await requireLastProjectCode(project.project_code);
      const department = await one<{ name: string }>('SELECT name FROM departments WHERE id = ?', [dispatch.dept_id]);
      await execute('DELETE FROM dispatches WHERE id = ?', [id]);
      await writeAudit({
        user: req.user, action: 'delete-dispatch', targetType: 'dispatch', targetId: id,
        detail: `永久删除 ${project?.project_code ?? ''}《${project?.project_name ?? ''}》/ ${department?.name ?? ''} 的派单，负责人 ${dispatch.assignee}`,
      });
    });
    broadcastChange('dispatches');
    res.json({ success: true });
  } catch (error) {
    handleError(error, res);
  }
}));

router.post('/admin/projects/clear', confirmAdminPassword, asyncRoute(async (req: AuthedRequest, res) => {
  const { revision, confirmation } = req.body ?? {};
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) || confirmation !== '清空全部项目') {
    res.status(400).json({ success: false, error: '确认信息不正确，请重新操作' });
    return;
  }
  try {
    const counts = await inTransaction(async () => {
      await lockDispatchCreation();
      const snapshot = await projectSnapshot();
      if (snapshot.revision !== revision) {
        throw new AdminActionError(409, '项目或派单已发生变化，请关闭窗口并重新确认');
      }
      await execute('DELETE FROM projects');
      await writeAudit({
        user: req.user, action: 'clear-projects', targetType: 'project',
        detail: `清空全部项目及派单：${snapshot.projectCount} 个项目、${snapshot.dispatchCount} 条派单`,
      });
      return { projectCount: snapshot.projectCount, dispatchCount: snapshot.dispatchCount };
    });
    broadcastChange('projects');
    res.json({ success: true, data: counts });
  } catch (error) {
    handleError(error, res);
  }
}));

router.post('/admin/audit-logs/clear', confirmAdminPassword, asyncRoute(async (req: AuthedRequest, res) => {
  if (req.body?.confirmation !== '清空操作日志') {
    res.status(400).json({ success: false, error: '确认信息不正确，请重新操作' });
    return;
  }
  const deleted = await inTransaction(async () => {
    const result = await execute('DELETE FROM audit_logs');
    await writeAudit({
      user: req.user, action: 'clear-audit-logs', targetType: 'audit',
      detail: `清空操作日志，共删除 ${result.affectedRows} 条；保留本次清空记录`,
    });
    return result.affectedRows;
  });
  broadcastChange('audit');
  res.json({ success: true, data: { deleted } });
}));

export default router;
