import crypto from 'node:crypto';
import type { BusinessLevel, ProjectType } from '../../shared/types';
import { all } from './storage';

export function now(): string {
  return new Date().toISOString();
}

export function monthStartIso(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).toISOString();
}

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(plain, salt, 64).toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [salt, derived] = stored.split(':');
  if (!salt || !derived) return false;
  const candidate = crypto.scryptSync(plain, salt, 64);
  const expected = Buffer.from(derived, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export const PROJECT_TYPES: ProjectType[] = [
  '矿业权出让收益报告',
  '矿业权出让底价报告',
  '矿业权评估报告',
  '矿业权价款退还报告',
  '咨询报告',
  '其他',
];

export const BUSINESS_LEVELS: BusinessLevel[] = ['A类', 'B类', 'C类'];

const DISPATCH_NO_RE = /^PD(\d{4})--(\d{4})$/;

export function isValidProjectType(value: string | null | undefined): value is ProjectType {
  return Boolean(value) && PROJECT_TYPES.includes(value as ProjectType);
}

export function isValidBusinessLevel(value: string | null | undefined): value is BusinessLevel | null {
  if (value === null || value === undefined || value === '') return true;
  return (BUSINESS_LEVELS as string[]).includes(value);
}

export function isValidDispatchNo(value: string | null | undefined): value is string {
  return typeof value === 'string' && DISPATCH_NO_RE.test(value);
}

export function isSingleAssignee(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 40 &&
    !/[\s,，、;；/／]/.test(value.trim());
}

export function isOptionalText(value: unknown, maxLength: number): boolean {
  return value === undefined || value === null ||
    (typeof value === 'string' && value.trim().length <= maxLength);
}

export async function generateDispatchNo(date = new Date()): Promise<string> {
  const year = date.getFullYear();
  const prefix = `PD${year}--`;
  const rows = await all<{ project_code: string }>('SELECT project_code FROM projects WHERE project_code LIKE ?', [`${prefix}%`]);
  const maxSeq = rows.reduce((max, row) => {
    const match = DISPATCH_NO_RE.exec(row.project_code);
    return match && Number(match[1]) === year ? Math.max(max, Number(match[2])) : max;
  }, 0);
  if (maxSeq >= 9999) throw new Error('DISPATCH_SEQUENCE_EXHAUSTED');
  return `${prefix}${String(maxSeq + 1).padStart(4, '0')}`;
}
