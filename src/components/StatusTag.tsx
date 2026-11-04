import { Tag } from 'antd';
import { DISPATCH_STATUS_META, PROJECT_STATUS_META } from '../constants';
import type { DispatchStatus, ProjectStatus } from '../../shared/types';

export function ProjectStatusTag({ status }: { status: ProjectStatus }) {
  const meta = PROJECT_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function DispatchStatusTag({ status }: { status: DispatchStatus }) {
  const meta = DISPATCH_STATUS_META[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}
