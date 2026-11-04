import { Router } from 'express';
import { writeAudit } from '../audit';
import { isOptionalText, isSingleAssignee, now } from '../common';
import { execute, lockDispatch, lockDispatchCreation } from '../storage';
import { asyncRoute } from '../async-route';
import { ConflictError, inTransaction } from '../errors';
import { broadcastChange } from '../sse';
import { requireDirector, type AuthedRequest } from '../middleware';
import { findDispatchById, loadProjectById } from '../repo';
import { createDispatchEntry } from '../dispatch-service';
import type { DispatchStatus } from '../../../shared/types';

const router = Router();

const DISPATCH_STATUSES: DispatchStatus[] = ['dispatched', 'done', 'terminated'];

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * 派单登记：新建项目 + 派单，或为已有项目追加派单。
 * 整个动作放在一个写事务里，任何一步冲突都整体回滚，
 * 不会留下"项目建了但派单没成功"的脏数据。
 */
router.post('/dispatches', requireDirector, asyncRoute(async (req: AuthedRequest, res) => {
  const user = req.user!;

  try {
    const project = await createDispatchEntry(req.body ?? {}, user);
    broadcastChange('dispatches');
    res.json({ success: true, data: project });
  } catch (error) {
    if (error instanceof ConflictError) {
      res.status(409).json({ success: false, error: error.conflict.message, conflict: error.conflict });
      return;
    }
    if (error instanceof Error && error.message === 'INVALID_DISPATCH_INPUT') {
      res.status(400).json({ success: false, error: '派单时请选择主要承接部门并填写一位项目负责人' });
      return;
    }
    if (error instanceof Error && error.message === 'INVALID_ADDITIONAL_FIELDS') {
      res.status(400).json({ success: false, error: '新增字段格式不正确或超出长度限制' });
      return;
    }
    if (error instanceof Error && error.message === 'INVALID_DEPARTMENT') {
      res.status(400).json({ success: false, error: '承接部门不存在' });
      return;
    }
    if (error instanceof Error && error.message === 'EMPTY_PROJECT_FIELDS') {
      res.status(400).json({ success: false, error: '请填写派单项目名称' });
      return;
    }
    if (error instanceof Error && error.message === 'INVALID_DISPATCH_NO') {
      res.status(400).json({ success: false, error: '派单单号格式不正确，应为 PD+年份+四位序号，例如 PD2026-0001' });
      return;
    }
    if (error instanceof Error && error.message === 'INVALID_PROJECT_TYPE') {
      res.status(400).json({ success: false, error: '交付成果类型不在允许范围内' });
      return;
    }
    if (error instanceof Error && error.message === 'INVALID_BUSINESS_LEVEL') {
      res.status(400).json({ success: false, error: '业务程度只能是 A类、B类 或 C类' });
      return;
    }
    // 部分唯一索引兜底：两个主任同时提交、业务层查重都漏过时，由数据库直接拒绝
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE|ER_DUP_ENTRY|Duplicate entry/i.test(message)) {
      const requestBody = req.body as { projectId?: number };
      const project = requestBody?.projectId ? await loadProjectById(requestBody.projectId) : undefined;
      res.status(409).json({
        success: false,
        error: '该项目已由该部门承接，请勿重复派单',
        conflict: { kind: 'duplicate-dispatch', message: '该项目已由该部门承接，请勿重复派单', project },
      });
      return;
    }
    throw error;
  }
}));

/**
 * 更新派单记录（状态 / 负责人 / 备注）。
 * 带 expectedUpdatedAt 做乐观并发控制：如果这条记录在你打开弹窗之后被别的主任改过，
 * 直接拒绝并让你刷新，避免"后写覆盖先写"导致台账失真。
 */
router.patch('/dispatches/:id', requireDirector, asyncRoute(async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { status, assignee, remark, teamMembers, signatoryOne, signatoryTwo, actualCompletionDate, expectedUpdatedAt } = (req.body ?? {}) as {
    status?: DispatchStatus;
    assignee?: string;
    remark?: string | null;
    teamMembers?: string | null;
    signatoryOne?: string | null;
    signatoryTwo?: string | null;
    actualCompletionDate?: string | null;
    expectedUpdatedAt?: string;
  };

  if (status !== undefined && !DISPATCH_STATUSES.includes(status)) {
    res.status(400).json({ success: false, error: '派单状态不合法' });
    return;
  }
  if (assignee !== undefined && !isSingleAssignee(assignee)) {
    res.status(400).json({ success: false, error: '请填写一位项目负责人，不能输入多个姓名' });
    return;
  }
  if (!isOptionalText(teamMembers, 500) || !isOptionalText(signatoryOne, 80) || !isOptionalText(signatoryTwo, 80)) {
    res.status(400).json({ success: false, error: '项目组成员或签字评估师格式不正确或超出长度限制' });
    return;
  }
  const user = req.user!;

  try {
    await inTransaction(async () => {
      await lockDispatchCreation();
      await lockDispatch(id);
      const current = await findDispatchById(id);
      if (!current) throw new Error('DISPATCH_NOT_FOUND');
      if (expectedUpdatedAt && expectedUpdatedAt !== current.updatedAt) {
        throw new ConflictError({ kind: 'stale-record', message: '记录已被他人修改，请刷新后重试', dispatch: current });
      }
      const nextStatus = status ?? current.status;
      const nextAssignee = assignee !== undefined ? text(assignee)! : current.assignee;
      const nextRemark = remark !== undefined ? text(remark) : current.remark;
      const nextTeam = teamMembers !== undefined ? text(teamMembers) : current.teamMembers;
      const nextSignatoryOne = signatoryOne !== undefined ? text(signatoryOne) : current.signatoryOne;
      const nextSignatoryTwo = signatoryTwo !== undefined ? text(signatoryTwo) : current.signatoryTwo;
      const nextCompletion = actualCompletionDate !== undefined ? text(actualCompletionDate) : current.actualCompletionDate;
      await execute('UPDATE dispatches SET status = ?, assignee = ?, remark = ?, team_members = ?, signatory_one = ?, signatory_two = ?, actual_completion_date = ?, updated_at = ? WHERE id = ?', [
        nextStatus, nextAssignee, nextRemark, nextTeam, nextSignatoryOne, nextSignatoryTwo, nextCompletion, now(), id,
      ]);
      if (nextStatus !== current.status) {
        await execute('UPDATE projects SET pending_reset = 0, updated_at = ? WHERE id = ?', [now(), current.projectId]);
      }
      const changes: string[] = [];
      if (nextStatus !== current.status) changes.push(`状态 ${current.status} → ${nextStatus}`);
      if (nextAssignee !== current.assignee) changes.push(`负责人 ${current.assignee} → ${nextAssignee}`);
      if (nextTeam !== current.teamMembers) changes.push('更新项目组成员');
      if (nextSignatoryOne !== current.signatoryOne || nextSignatoryTwo !== current.signatoryTwo) changes.push('更新签字评估师');
      if (nextCompletion !== current.actualCompletionDate) changes.push('更新实际完成日期');
      await writeAudit({
        user,
        action: nextStatus === 'terminated' && current.status !== 'terminated' ? 'revoke-dispatch' : 'update-dispatch',
        targetType: 'dispatch',
        targetId: id,
        detail: `${current.projectCode}《${current.projectName}》/ ${current.deptName}：${changes.join('；') || '更新备注'}`,
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'DISPATCH_NOT_FOUND') {
      res.status(404).json({ success: false, error: '派单记录不存在' });
      return;
    }
    if (error instanceof Error && /UNIQUE|ER_DUP_ENTRY|Duplicate entry/i.test(error.message)) {
      res.status(409).json({ success: false, error: '该项目已有该部门的有效派单，无法恢复此记录' });
      return;
    }
    if (error instanceof ConflictError) {
      res.status(409).json({ success: false, error: error.conflict.message, conflict: error.conflict });
      return;
    }
    throw error;
  }

  broadcastChange('dispatches');
  res.json({ success: true, data: await findDispatchById(id) });
}));

export default router;
