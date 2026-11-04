import dayjs from 'dayjs';
import type { BusinessLevel, DispatchStatus, ProjectStatus, ProjectType } from '../shared/types';

export const PROJECT_STATUS_META: Record<ProjectStatus, { label: string; color: string }> = {
  pending: { label: '待派单', color: 'orange' },
  dispatched: { label: '已派单', color: 'blue' },
  done: { label: '已完成', color: 'green' },
  terminated: { label: '已撤销', color: 'default' },
};

export const DISPATCH_STATUS_META: Record<DispatchStatus, { label: string; color: string }> = {
  dispatched: { label: '已派单', color: 'blue' },
  done: { label: '已完成', color: 'green' },
  terminated: { label: '已撤销', color: 'default' },
};

export const PROJECT_TYPES: ProjectType[] = ['资产评估报告', '房地产估价报告（含租金）', '土地估价报告', '矿业权报告', '债权分析报告', '咨询报告', '预估报告（函）'];

export const BUSINESS_LEVELS: BusinessLevel[] = ['A类', 'B类', 'C类'];

export const EVALUATION_PURPOSES = [
  '产权转让',
  '资产转让、置换、拍卖',
  '资产抵押/质押',
  '资产租赁',
  '资产收购',
  '接受抵债资产',
  '追溯评估',
  '复核报告',
  '财务会计报告目的',
  '资产涉诉',
  '资产偿债',
  '资产补偿/损失补偿',
  '其他',
];

/** 看板列顺序：待派单不在这里，它对应"尚无派单记录的项目" */
export const BOARD_COLUMNS: { key: DispatchStatus; title: string; wide?: boolean }[] = [
  { key: 'dispatched', title: '已派单', wide: true },
  { key: 'done', title: '已完成' },
  { key: 'terminated', title: '已撤销' },
];

export { AUDIT_ACTION_META } from '../shared/audit-actions';

export function formatDateTime(value: string | null | undefined): string {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—';
}

export function formatDate(value: string | null | undefined): string {
  return value ? dayjs(value).format('YYYY-MM-DD') : '—';
}

export function formatFee(value: number | null | undefined): string {
  return value == null ? '—' : `¥${value.toLocaleString('zh-CN')}`;
}

export function isOverdue(deadline: string | null | undefined, now = dayjs()): boolean {
  if (!deadline) return false;
  const date = dayjs(deadline);
  if (!date.isValid()) return false;
  const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? date.endOf('day') : date;
  return now.isAfter(cutoff);
}

/** 剩余工期：根据要求完成时间计算剩余/超期天数，用于提醒派单人跟踪。 */
export function deadlineRemaining(deadline: string | null | undefined, now = dayjs()): { overdue: boolean; urgent: boolean; label: string } {
  if (!deadline) return { overdue: false, urgent: false, label: '—' };
  const target = dayjs(deadline);
  if (!target.isValid()) return { overdue: false, urgent: false, label: '—' };
  const days = target.startOf('day').diff(now.startOf('day'), 'day');
  if (days > 0) return { overdue: false, urgent: false, label: `剩余 ${days} 天` };
  if (days === 0) return { overdue: false, urgent: true, label: '今天到期' };
  return { overdue: true, urgent: true, label: `已超期 ${-days} 天` };
}

export function isCreatedWithinDays(createdAt: string, days: number, now = dayjs()): boolean {
  const created = dayjs(createdAt);
  return created.isValid() && !created.isBefore(now.startOf('day').subtract(days - 1, 'day')) && !created.isAfter(now);
}
