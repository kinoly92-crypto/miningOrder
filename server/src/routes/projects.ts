import { Router } from 'express';
import { writeAudit } from '../audit';
import { asyncRoute } from '../async-route';
import { now, isOptionalText, isValidBusinessLevel, isValidProjectType } from '../common';
import { ConflictError, inTransaction } from '../errors';
import { requireDirector, type AuthedRequest } from '../middleware';
import { findProjectByCode, listDepartments, loadDispatches, loadProjectById, loadProjects } from '../repo';
import { broadcastChange } from '../sse';
import { execute, lockDispatchCreation } from '../storage';

const router = Router();

/** 项目部：台账 / 看板的唯一数据来源 */
router.get('/projects', asyncRoute(async (_req, res) => {
  res.json({ success: true, data: await loadProjects() });
}));

router.post('/projects/:id/reset-pending', requireDirector, asyncRoute(async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const expectedUpdatedAt = req.body?.expectedUpdatedAt;
  if (!Number.isSafeInteger(id) || id <= 0 || typeof expectedUpdatedAt !== 'string') {
    res.status(400).json({ success: false, error: '项目信息不完整，请刷新后重试' });
    return;
  }
  const changed = await inTransaction(async () => {
    await lockDispatchCreation();
    const project = await loadProjectById(id);
    if (!project || project.status !== 'terminated' || project.updatedAt !== expectedUpdatedAt) return false;
    await execute('UPDATE projects SET pending_reset = 1, updated_at = ? WHERE id = ?', [now(), id]);
    await writeAudit({
      user: req.user, action: 'reset-project-pending', targetType: 'project', targetId: id,
      detail: `${project.projectCode}《${project.projectName}》恢复为待派单，撤销记录保留`,
    });
    return true;
  });
  if (!changed) {
    res.status(409).json({ success: false, error: '项目状态已变化，请刷新后重试' });
    return;
  }
  broadcastChange('projects');
  res.json({ success: true });
}));

router.post('/projects/:id/revoke-pending', requireDirector, asyncRoute(async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const expectedUpdatedAt = req.body?.expectedUpdatedAt;
  if (!Number.isSafeInteger(id) || id <= 0 || typeof expectedUpdatedAt !== 'string') {
    res.status(400).json({ success: false, error: '项目信息不完整，请刷新后重试' });
    return;
  }
  const changed = await inTransaction(async () => {
    await lockDispatchCreation();
    const project = await loadProjectById(id);
    if (!project || project.status !== 'pending' || project.updatedAt !== expectedUpdatedAt) return false;
    await execute('UPDATE projects SET pending_reset = 2, updated_at = ? WHERE id = ?', [now(), id]);
    await writeAudit({
      user: req.user, action: 'revoke-pending-project', targetType: 'project', targetId: id,
      detail: `撤销待派单项目 ${project.projectCode}《${project.projectName}》，记录保留`,
    });
    return true;
  });
  if (!changed) {
    res.status(409).json({ success: false, error: '项目状态已变化，请刷新后重试' });
    return;
  }
  broadcastChange('projects');
  res.json({ success: true });
}));

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function fee(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 修改项目基本信息（部门主任 / 管理员），带乐观并发控制。 */
router.patch('/projects/:id', requireDirector, asyncRoute(async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = (req.body ?? {}) as {
    projectName?: unknown;
    clientName?: unknown;
    clientContact?: unknown;
    clientPhone?: unknown;
    businessSource?: unknown;
    businessLevel?: unknown;
    projectType?: unknown;
    evalPurpose?: unknown;
    estimatedFee?: unknown;
    deadline?: unknown;
    expectedUpdatedAt?: unknown;
  };

  if (!Number.isSafeInteger(id) || id <= 0 || typeof body.expectedUpdatedAt !== 'string') {
    res.status(400).json({ success: false, error: '项目信息不完整，请刷新后重试' });
    return;
  }
  const projectName = text(body.projectName);
  if (!projectName || projectName.length > 120) {
    res.status(400).json({ success: false, error: '请填写派单项目名称（不超过 120 字）' });
    return;
  }
  if (!isValidProjectType(text(body.projectType))) {
    res.status(400).json({ success: false, error: '交付成果类型不在允许范围内' });
    return;
  }
  if (!isValidBusinessLevel(text(body.businessLevel))) {
    res.status(400).json({ success: false, error: '业务程度只能是 A类、B类 或 C类' });
    return;
  }
  if (!isOptionalText(text(body.clientContact), 100) || !isOptionalText(text(body.clientPhone), 60) ||
      !isOptionalText(text(body.businessSource), 200) || !isOptionalText(text(body.evalPurpose), 200)) {
    res.status(400).json({ success: false, error: '新增字段格式不正确或超出长度限制' });
    return;
  }

  const user = req.user!;
  try {
    const updated = await inTransaction(async () => {
      await lockDispatchCreation();
      const project = await loadProjectById(id);
      if (!project) throw new Error('PROJECT_NOT_FOUND');
      if (body.expectedUpdatedAt !== project.updatedAt) {
        throw new ConflictError({ kind: 'stale-record', message: '项目信息已被他人修改，请刷新后重试', project });
      }
      await execute(
        `UPDATE projects SET
           project_name = ?, client_name = ?, client_contact = ?, client_phone = ?,
           business_source = ?, business_level = ?, project_type = ?, eval_purpose = ?,
           estimated_fee = ?, deadline = ?, updated_at = ?
         WHERE id = ?`,
        [
          projectName,
          text(body.clientName),
          text(body.clientContact),
          text(body.clientPhone),
          text(body.businessSource),
          text(body.businessLevel),
          text(body.projectType)!,
          text(body.evalPurpose),
          fee(body.estimatedFee),
          text(body.deadline),
          now(),
          id,
        ],
      );
      await writeAudit({
        user,
        action: 'update-project',
        targetType: 'project',
        targetId: id,
        detail: `修改项目 ${project.projectCode}《${project.projectName}》基本信息`,
      });
      return (await loadProjectById(id))!;
    });
    broadcastChange('projects');
    res.json({ success: true, data: updated });
  } catch (error) {
    if (error instanceof Error && error.message === 'PROJECT_NOT_FOUND') {
      res.status(404).json({ success: false, error: '项目不存在或已被删除' });
      return;
    }
    if (error instanceof ConflictError) {
      res.status(409).json({ success: false, error: error.conflict.message, conflict: error.conflict });
      return;
    }
    throw error;
  }
}));

/** 派单记录扁平列表（台账的"派单记录视角"） */
router.get('/dispatches', asyncRoute(async (_req, res) => {
  res.json({ success: true, data: await loadDispatches() });
}));

function normalizeName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function similarNames(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 4) return false;
  if (left.includes(right) || right.includes(left)) return true;
  const pairs = (value: string) => {
    const result = new Map<string, number>();
    for (let i = 0; i < value.length - 1; i++) {
      const pair = value.slice(i, i + 2);
      result.set(pair, (result.get(pair) ?? 0) + 1);
    }
    return result;
  };
  const a = pairs(left);
  const b = pairs(right);
  let overlap = 0;
  for (const [pair, count] of a) overlap += Math.min(count, b.get(pair) ?? 0);
  return (2 * overlap) / (left.length + right.length - 2) >= 0.6;
}

router.get('/projects/similar', asyncRoute(async (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  const normalized = normalizeName(name);
  if (normalized.length < 2 || name.length > 120) {
    res.status(400).json({ success: false, error: '项目名称需包含至少两个文字或字符，且不超过 120 字' });
    return;
  }
  const matches = (await loadProjects()).filter((project) => {
    const existing = normalizeName(project.projectName);
    return existing.length >= 2 && similarNames(normalized, existing);
  });
  res.json({ success: true, data: matches });
}));

/**
 * 录入即查重：主任在派单登记页填完派单单号、光标一移开就调这个接口。
 * 已建档则把该项目连同已有派单记录一并返回，前端直接给出红色提示，
 * 把"重复派单"拦在提交之前。
 */
router.get('/projects/lookup', asyncRoute(async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  if (!code) {
    res.status(400).json({ success: false, error: '请提供派单单号' });
    return;
  }
  const project = await findProjectByCode(code);
  res.json({ success: true, data: { found: Boolean(project), project: project ?? null } });
}));

router.get('/departments', asyncRoute(async (_req, res) => {
  res.json({ success: true, data: await listDepartments() });
}));

export default router;
