import { AppstoreOutlined, DeleteOutlined, DownloadOutlined, ReloadOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, Card, Input, Modal, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ChangeEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { DispatchStatusTag, ProjectStatusTag } from '../components/StatusTag';
import ConfirmDestructiveModal from '../components/ConfirmDestructiveModal';
import UpdateDispatchModal from '../components/UpdateDispatchModal';
import { DISPATCH_STATUS_META, PROJECT_TYPES, deadlineRemaining, formatDate, formatDateTime, formatFee, isCreatedWithinDays, isOverdue } from '../constants';
import { useLiveData } from '../hooks/useLiveData';
import type { BatchImportResult, Department, DispatchRecord, DispatchStatus, Project } from '../../shared/types';

type ViewMode = 'project' | 'dispatch';
type DeleteAction = {
  title: string;
  description: ReactNode;
  confirmationText?: string;
  okText?: string;
  successMessage: string;
  submit: (password: string, confirmation: string) => Promise<void>;
};

export default function Ledger() {
  const { user } = useAuth();
  const { message, modal } = AntdApp.useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isDirector = user?.role === 'director' || user?.role === 'admin';
  const isSysadmin = user?.role === 'admin' && user.username === 'sysadmin';

  const { data, loading, reload } = useLiveData(() => api.get<Project[]>('/projects'));
  const { data: departments } = useLiveData(() => api.get<Department[]>('/departments'));
  const [editing, setEditing] = useState<DispatchRecord | null>(null);
  const [importing, setImporting] = useState(false);
  const [preparingClear, setPreparingClear] = useState(false);
  const [deleteAction, setDeleteAction] = useState<DeleteAction | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const dispatchIdParam = searchParams.get('dispatchId');
  const view: ViewMode = searchParams.get('view') === 'dispatch' || dispatchIdParam ? 'dispatch' : 'project';
  const selectedStatus = searchParams.get('status');
  const validStatuses: string[] = view === 'project'
    ? ['pending', 'dispatched', 'done', 'terminated']
    : Object.keys(DISPATCH_STATUS_META);
  const statusFilter = selectedStatus && validStatuses.includes(selectedStatus) ? selectedStatus : undefined;
  const deadlineFilter = searchParams.get('deadline');
  const [keyword, setKeyword] = useState(() => searchParams.get('code') ?? '');
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
  const [deptFilter, setDeptFilter] = useState<number | undefined>(undefined);
  const [recentDays, setRecentDays] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState(() => dayjs());
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setIsMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  function setView(nextView: ViewMode) {
    const next = new URLSearchParams(searchParams);
    if (nextView === 'dispatch') next.set('view', 'dispatch');
    else next.delete('view');
    next.delete('status');
    setSearchParams(next);
  }

  function setStatusFilter(status: string | undefined) {
    const next = new URLSearchParams(searchParams);
    if (status) next.set('status', status);
    else next.delete('status');
    setSearchParams(next);
  }

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(dayjs()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const projects = data ?? [];
  const kw = keyword.trim().toLowerCase();
  const matchKeyword = (p: Project) =>
    !kw ||
    p.projectCode.toLowerCase().includes(kw) ||
    p.projectName.toLowerCase().includes(kw) ||
    (p.clientName ?? '').toLowerCase().includes(kw) ||
    p.dispatches.some((d) => d.assignee.toLowerCase().includes(kw));

  // 「按项目」视角：一行一个项目，展开可看该项目的全部派单明细
  const projectRows = projects.filter((p) => {
    if (!matchKeyword(p)) return false;
    if (recentDays && !isCreatedWithinDays(p.createdAt, recentDays, currentTime)) return false;
    if (typeFilter && p.projectType !== typeFilter) return false;
    if (statusFilter && p.status !== statusFilter) return false;
    if (deptFilter && !p.dispatches.some((d) => d.deptId === deptFilter && d.status !== 'terminated')) return false;
    if (deadlineFilter === 'overdue') {
      if (p.status === 'done' || p.status === 'terminated' || !isOverdue(p.deadline, currentTime)) return false;
    } else if (deadlineFilter === 'upcoming') {
      if (p.status === 'done' || p.status === 'terminated' || !p.deadline) return false;
      const days = dayjs(p.deadline).startOf('day').diff(currentTime.startOf('day'), 'day');
      if (days < 0 || days > 3) return false;
    }
    return true;
  });

  // 「按派单记录」视角：一行一条派单记录，就是主任口中的"派单台账"
  const dispatchRows = projects
    .flatMap((p) => p.dispatches.map((d) => ({ project: p, dispatch: d })))
    .filter(({ project, dispatch }) => {
      if (dispatchIdParam && String(dispatch.id) !== dispatchIdParam) return false;
      if (recentDays && !isCreatedWithinDays(project.createdAt, recentDays, currentTime)) return false;
      if (typeFilter && project.projectType !== typeFilter) return false;
      if (deptFilter && dispatch.deptId !== deptFilter) return false;
      if (statusFilter && dispatch.status !== statusFilter) return false;
      if (
        kw &&
        !project.projectCode.toLowerCase().includes(kw) &&
        !project.projectName.toLowerCase().includes(kw) &&
        !dispatch.assignee.toLowerCase().includes(kw) &&
        !(project.clientName ?? '').toLowerCase().includes(kw)
      ) {
        return false;
      }
      return true;
    });

  function revoke(record: DispatchRecord) {
    modal.confirm({
      title: '确认撤销这条派单？',
      content: `${record.deptName} 承接的「${record.projectName}」将被标记为已撤销。记录保留在台账与操作日志中可追溯，该部门可以重新承接该项目。`,
      okText: '确认撤销',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.patch(`/dispatches/${record.id}`, {
            status: 'terminated',
            expectedUpdatedAt: record.updatedAt,
          });
          message.success('已撤销派单');
        } catch (err) {
          message.error(err instanceof Error ? err.message : '撤销失败');
          await reload(true);
        }
      },
    });
  }

  function resetPending(project: Project) {
    modal.confirm({
      title: '恢复为待派单？',
      content: '项目将重新计入待派单，原有撤销记录仍会保留。',
      okText: '确认恢复',
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.post(`/projects/${project.id}/reset-pending`, { expectedUpdatedAt: project.updatedAt });
          message.success('项目已恢复为待派单');
          await reload(true);
        } catch (err) {
          message.error(err instanceof Error ? err.message : '恢复失败');
          await reload(true);
        }
      },
    });
  }

  function revokePending(project: Project) {
    modal.confirm({
      title: '撤销待派单项目？',
      content: `「${project.projectName}」将标记为已撤销，项目和编号会保留。`,
      okText: '确认撤销',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.post(`/projects/${project.id}/revoke-pending`, { expectedUpdatedAt: project.updatedAt });
          message.success('项目已撤销');
          await reload(true);
        } catch (err) {
          message.error(err instanceof Error ? err.message : '撤销失败');
          await reload(true);
        }
      },
    });
  }

  function deleteDispatch(record: DispatchRecord) {
    setDeleteAction({
      title: '永久删除派单',
      description: `将永久删除 ${record.projectCode}《${record.projectName}》中 ${record.deptName} 的派单（负责人：${record.assignee}）。项目本身会保留。`,
      successMessage: '派单已永久删除',
      submit: async (password) => {
        await api.post('/admin/dispatches/delete', { id: record.id, expectedUpdatedAt: record.updatedAt, password });
      },
    });
  }

  function deleteProject(project: Project) {
    setDeleteAction({
      title: '永久删除项目',
      description: `将永久删除 ${project.projectCode}《${project.projectName}》及其全部 ${project.dispatches.length} 条派单。仅允许删除同年度当前最大编号，删除后的编号可能被重新使用。`,
      successMessage: '项目及关联派单已永久删除',
      submit: async (password) => {
        await api.post('/admin/projects/delete', {
          id: project.id,
          expectedCode: project.projectCode,
          expectedUpdatedAt: project.updatedAt,
          expectedDispatches: project.dispatches.map((d) => ({ id: d.id, updatedAt: d.updatedAt })),
          password,
        });
      },
    });
  }

  async function clearProjects() {
    setPreparingClear(true);
    try {
      const preview = await api.get<{ revision: string; projectCount: number; dispatchCount: number }>(
        '/admin/projects/clear-preview',
      );
      if (!preview.projectCount) {
        message.info('当前没有可清空的项目');
        return;
      }
      setDeleteAction({
        title: '清空全部项目和派单',
        description: `将永久删除全部 ${preview.projectCount} 个项目和 ${preview.dispatchCount} 条派单，包括当前筛选条件之外的数据。账号、部门和操作日志会保留，派单编号可能重新从 0001 开始。`,
        confirmationText: '清空全部项目',
        okText: '确认清空',
        successMessage: '项目和派单已清空',
        submit: async (password, confirmation) => {
          await api.post('/admin/projects/clear', { revision: preview.revision, password, confirmation });
        },
      });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取清空范围失败');
    } finally {
      setPreparingClear(false);
    }
  }

  const actionCell = (record: DispatchRecord) =>
    isDirector ? (
      <Space size={4}>
        <Button size="small" onClick={() => setEditing(record)}>
          更新
        </Button>
        {record.status !== 'terminated' ? (
          <Button size="small" danger onClick={() => revoke(record)}>
            撤销
          </Button>
        ) : null}
        {isSysadmin ? (
          <Button size="small" danger onClick={() => deleteDispatch(record)}>
            永久删除
          </Button>
        ) : null}
      </Space>
    ) : (
      <Typography.Text type="secondary">—</Typography.Text>
    );

  const dispatchColumns: ColumnsType<DispatchRecord> = [
    { title: '主要承接部门', dataIndex: 'deptName', width: 140 },
    { title: '项目负责人', dataIndex: 'assignee', width: 120 },
    { title: '项目组成员', dataIndex: 'teamMembers', width: 180, render: (v: string | null) => v || '—' },
    { title: '签字评估师一', dataIndex: 'signatoryOne', width: 140, render: (v: string | null) => v || '—' },
    { title: '签字评估师二', dataIndex: 'signatoryTwo', width: 140, render: (v: string | null) => v || '—' },
    { title: '派单人', dataIndex: 'dispatcherName', width: 100 },
    { title: '派单时间', dataIndex: 'dispatchedAt', width: 160, render: (v: string) => formatDateTime(v) },
    { title: '状态', dataIndex: 'status', width: 100, render: (s: DispatchStatus) => <DispatchStatusTag status={s} /> },
    { title: '实际完成时间', dataIndex: 'actualCompletionDate', width: 140, render: (v: string | null) => formatDate(v) },
    { title: '备注', dataIndex: 'remark', render: (v: string | null) => v || '—' },
    { title: '操作', key: 'action', width: 240, render: (_: unknown, r: DispatchRecord) => actionCell(r) },
  ];

  const projectColumns: ColumnsType<Project> = [
    {
      title: '派单单号',
      dataIndex: 'projectCode',
      width: 130,
      fixed: isMobile ? undefined : 'left',
      render: (v: string) => <span className="board-card-code">{v}</span>,
    },
    { title: '派单项目名称', dataIndex: 'projectName', width: 300, ellipsis: true },
    { title: '委托方', dataIndex: 'clientName', width: 190, ellipsis: true, render: (v: string | null) => v ?? '—' },
    { title: '委托方联系人', dataIndex: 'clientContact', width: 140, render: (v: string | null) => v || '—' },
    { title: '委托方联系电话', dataIndex: 'clientPhone', width: 160, render: (v: string | null) => v || '—' },
    { title: '业务来源', dataIndex: 'businessSource', width: 160, ellipsis: true, render: (v: string | null) => v || '—' },
    { title: '业务程度', dataIndex: 'businessLevel', width: 100, render: (v: string | null) => v || '—' },
    { title: '交付成果类型', dataIndex: 'projectType', width: 130 },
    {
      title: '主要承接部门',
      key: 'dept',
      width: 190,
      render: (_: unknown, p: Project) =>
        p.dispatches.length === 0 ? (
          <Tag color="orange">未派单</Tag>
        ) : (
          <Space size={4} wrap>
            {p.dispatches.map((d) => (
              <Tag key={d.id} color={d.status === 'terminated' ? 'default' : 'geekblue'}>
                {d.deptName}
                {d.status === 'terminated' ? '（已撤销）' : ''}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: '项目负责人',
      key: 'assignee',
      width: 150,
      render: (_: unknown, p: Project) => {
        const names = p.dispatches.filter((d) => d.status !== 'terminated').map((d) => d.assignee);
        return names.length ? names.join('、') : '—';
      },
    },
    ...(['teamMembers', 'signatoryOne', 'signatoryTwo'] as const).map((key, index) => ({
      title: ['项目组成员', '签字评估师一', '签字评估师二'][index],
      key,
      width: index === 0 ? 190 : 150,
      render: (_: unknown, p: Project) => p.dispatches
        .filter((d) => d.status !== 'terminated' && d[key])
        .map((d) => d[key]).join('；') || '—',
    })),
    { title: '项目状态', dataIndex: 'status', width: 110, render: (s: Project['status']) => <ProjectStatusTag status={s} /> },
    { title: '创建日期', dataIndex: 'createdAt', width: 160, render: (v: string) => formatDateTime(v) },
    {
      title: '要求完成时间',
      dataIndex: 'deadline',
      width: 170,
      render: (v: string | null, p: Project) => <Space size={4}>{formatDate(v)}{p.status !== 'done' && isOverdue(v, currentTime) ? <Tag color="red">已超时</Tag> : null}</Space>,
    },
    {
      title: '剩余工期',
      key: 'dispatchDeadline',
      width: 130,
      render: (_: unknown, p: Project) => {
        const completionDate = p.status === 'done'
          ? p.dispatches.map((d) => d.actualCompletionDate).filter(Boolean).sort().pop() ?? null
          : null;
        const reminder = deadlineRemaining(p.deadline, completionDate ? dayjs(completionDate) : currentTime);
        return reminder.urgent ? <Tag color="red">{reminder.label}</Tag> : <Typography.Text>{reminder.label}</Typography.Text>;
      },
    },
    { title: '预估收费', dataIndex: 'estimatedFee', width: 120, render: (v: number | null) => formatFee(v) },
    {
      title: '最近派单时间',
      key: 'lastDispatch',
      width: 160,
      render: (_: unknown, p: Project) => formatDateTime(p.dispatches[0]?.dispatchedAt),
    },
    {
      title: '操作',
      key: 'action',
      width: 240,
      fixed: isMobile ? undefined : 'right',
      render: (_: unknown, p: Project) =>
        isDirector ? (
          <Space size={4} wrap>
            <Button
              size="small"
              onClick={() => navigate(`/dispatch/new?code=${encodeURIComponent(p.projectCode)}`)}
            >
              派单 / 追加
            </Button>
            <Button
              size="small"
              onClick={() => navigate(`/dispatch/new?code=${encodeURIComponent(p.projectCode)}&mode=edit`)}
            >
              修改
            </Button>
            {p.status === 'terminated' ? (
              <Button size="small" onClick={() => resetPending(p)}>恢复待派单</Button>
            ) : null}
            {p.status === 'pending' ? (
              <Button size="small" danger onClick={() => revokePending(p)}>撤销</Button>
            ) : null}
            {isSysadmin ? (
              <Button size="small" danger onClick={() => deleteProject(p)}>
                永久删除
              </Button>
            ) : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  const dispatchViewColumns: ColumnsType<{ project: Project; dispatch: DispatchRecord }> = [
    {
      title: '派单单号',
      key: 'code',
      width: 130,
      fixed: isMobile ? undefined : 'left',
      render: (_: unknown, r) => <span className="board-card-code">{r.project.projectCode}</span>,
    },
    { title: '派单项目名称', key: 'name', width: 280, ellipsis: true, render: (_: unknown, r) => r.project.projectName },
    { title: '委托方', key: 'client', width: 180, ellipsis: true, render: (_: unknown, r) => r.project.clientName ?? '—' },
    { title: '委托方联系人', key: 'clientContact', width: 140, render: (_: unknown, r) => r.project.clientContact || '—' },
    { title: '委托方联系电话', key: 'clientPhone', width: 160, render: (_: unknown, r) => r.project.clientPhone || '—' },
    { title: '主要承接部门', key: 'dept', width: 140, render: (_: unknown, r) => r.dispatch.deptName },
    { title: '项目负责人', key: 'assignee', width: 120, render: (_: unknown, r) => r.dispatch.assignee },
    { title: '项目组成员', key: 'teamMembers', width: 180, render: (_: unknown, r) => r.dispatch.teamMembers || '—' },
    { title: '签字评估师一', key: 'signatoryOne', width: 140, render: (_: unknown, r) => r.dispatch.signatoryOne || '—' },
    { title: '签字评估师二', key: 'signatoryTwo', width: 140, render: (_: unknown, r) => r.dispatch.signatoryTwo || '—' },
    { title: '派单人', key: 'dispatcher', width: 100, render: (_: unknown, r) => r.dispatch.dispatcherName },
    { title: '创建日期', key: 'createdAt', width: 160, render: (_: unknown, r) => formatDateTime(r.project.createdAt) },
    {
      title: '要求完成时间',
      key: 'deadline',
      width: 170,
      render: (_: unknown, r) => <Space size={4}>{formatDate(r.project.deadline)}{r.dispatch.status !== 'done' && isOverdue(r.project.deadline, currentTime) ? <Tag color="red">已超时</Tag> : null}</Space>,
    },
    {
      title: '剩余工期',
      key: 'dispatchDeadline',
      width: 130,
      render: (_: unknown, r) => {
        const completionDate = r.dispatch.status === 'done' ? r.dispatch.actualCompletionDate : null;
        const reminder = deadlineRemaining(r.project.deadline, completionDate ? dayjs(completionDate) : currentTime);
        return reminder.urgent ? <Tag color="red">{reminder.label}</Tag> : <Typography.Text>{reminder.label}</Typography.Text>;
      },
    },
    { title: '预估收费', key: 'estimatedFee', width: 120, render: (_: unknown, r) => formatFee(r.project.estimatedFee) },
    { title: '实际完成时间', key: 'actualCompletionDate', width: 140, render: (_: unknown, r) => formatDate(r.dispatch.actualCompletionDate) },
    {
      title: '派单时间',
      key: 'at',
      width: 160,
      sorter: (a, b) => a.dispatch.dispatchedAt.localeCompare(b.dispatch.dispatchedAt),
      defaultSortOrder: 'descend',
      render: (_: unknown, r) => formatDateTime(r.dispatch.dispatchedAt),
    },
    { title: '状态', key: 'status', width: 100, render: (_: unknown, r) => <DispatchStatusTag status={r.dispatch.status} /> },
    { title: '备注', key: 'remark', render: (_: unknown, r) => r.dispatch.remark || '—' },
    { title: '操作', key: 'action', width: 240, fixed: isMobile ? undefined : 'right', render: (_: unknown, r) => actionCell(r.dispatch) },
  ];

  const compare = (a: string | number | null | undefined, b: string | number | null | undefined) =>
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a ?? '').localeCompare(String(b ?? ''), 'zh-CN', { numeric: true });
  const projectValues: Record<string, (p: Project) => string | number | null | undefined> = {
    projectCode: (p) => p.projectCode, projectName: (p) => p.projectName,
    clientName: (p) => p.clientName, clientContact: (p) => p.clientContact, clientPhone: (p) => p.clientPhone, projectType: (p) => p.projectType,
    businessSource: (p) => p.businessSource, businessLevel: (p) => p.businessLevel,
    dept: (p) => p.dispatches.filter((d) => d.status !== 'terminated').map((d) => d.deptName).join('、'),
    assignee: (p) => p.dispatches.filter((d) => d.status !== 'terminated').map((d) => d.assignee).join('、'),
    teamMembers: (p) => p.dispatches.filter((d) => d.status !== 'terminated').map((d) => d.teamMembers ?? '').join('；'),
    signatoryOne: (p) => p.dispatches.filter((d) => d.status !== 'terminated').map((d) => d.signatoryOne ?? '').join('；'),
    signatoryTwo: (p) => p.dispatches.filter((d) => d.status !== 'terminated').map((d) => d.signatoryTwo ?? '').join('；'),
    status: (p) => p.status, createdAt: (p) => p.createdAt, deadline: (p) => p.deadline,
    dispatchDeadline: (p) => deadlineRemaining(p.deadline).label,
    estimatedFee: (p) => p.estimatedFee, lastDispatch: (p) => p.dispatches[0]?.dispatchedAt,
  };
  const dispatchValues: Record<string, (d: DispatchRecord) => string | null> = {
    deptName: (d) => d.deptName, assignee: (d) => d.assignee, dispatcherName: (d) => d.dispatcherName,
    teamMembers: (d) => d.teamMembers, signatoryOne: (d) => d.signatoryOne, signatoryTwo: (d) => d.signatoryTwo,
    dispatchedAt: (d) => d.dispatchedAt, status: (d) => d.status, remark: (d) => d.remark,
    actualCompletionDate: (d) => d.actualCompletionDate,
  };
  const dispatchViewValues: Record<string, (r: { project: Project; dispatch: DispatchRecord }) => string | number | null | undefined> = {
    code: (r) => r.project.projectCode, name: (r) => r.project.projectName, client: (r) => r.project.clientName,
    clientContact: (r) => r.project.clientContact, clientPhone: (r) => r.project.clientPhone,
    dept: (r) => r.dispatch.deptName, assignee: (r) => r.dispatch.assignee,
    teamMembers: (r) => r.dispatch.teamMembers, signatoryOne: (r) => r.dispatch.signatoryOne, signatoryTwo: (r) => r.dispatch.signatoryTwo,
    dispatcher: (r) => r.dispatch.dispatcherName, createdAt: (r) => r.project.createdAt,
    deadline: (r) => r.project.deadline, at: (r) => r.dispatch.dispatchedAt,
    dispatchDeadline: (r) => deadlineRemaining(r.project.deadline).label,
    estimatedFee: (r) => r.project.estimatedFee,
    actualCompletionDate: (r) => r.dispatch.actualCompletionDate,
    status: (r) => r.dispatch.status, remark: (r) => r.dispatch.remark,
  };
  const sortableProjects = projectColumns.map((column) => {
    const value = projectValues[String(column.key ?? ('dataIndex' in column ? column.dataIndex : ''))];
    return value ? { ...column, sorter: (a: Project, b: Project) => compare(value(a), value(b)) } : column;
  });
  const sortableDispatches = dispatchColumns.map((column) => {
    const value = dispatchValues[String(column.key ?? ('dataIndex' in column ? column.dataIndex : ''))];
    return value ? { ...column, sorter: (a: DispatchRecord, b: DispatchRecord) => compare(value(a), value(b)) } : column;
  });
  const sortableDispatchView = dispatchViewColumns.map((column) => {
    const value = dispatchViewValues[String(column.key ?? ('dataIndex' in column ? column.dataIndex : ''))];
    return value ? { ...column, sorter: (a: { project: Project; dispatch: DispatchRecord }, b: { project: Project; dispatch: DispatchRecord }) => compare(value(a), value(b)) } : column;
  });

  function saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function handleDownload(path: string, fallbackName: string) {
    try {
      const { blob, filename } = await api.download(path);
      saveBlob(blob, filename ?? fallbackName);
      message.success('文件已开始下载');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '下载失败');
    }
  }

  function showImportResult(result: BatchImportResult) {
    const failedRows = result.rows.filter((item) => !item.success);
    modal.info({
      title: '批量导入完成',
      width: 760,
      okText: '知道了',
      content: (
        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          <p>
            共导入 <strong>{result.total}</strong> 行，成功 <strong>{result.successCount}</strong> 行，失败{' '}
            <strong>{result.failureCount}</strong> 行。
          </p>
          {failedRows.length > 0 ? (
            <div>
              <Typography.Text strong>失败明细</Typography.Text>
              <div style={{ marginTop: 8 }}>
                {failedRows.slice(0, 20).map((item) => (
                  <div key={`${item.rowNumber}-${item.message}`} style={{ marginBottom: 6 }}>
                    第 {item.rowNumber} 行：{item.message}
                  </div>
                ))}
                {failedRows.length > 20 ? <div>其余 {failedRows.length - 20} 行失败明细请修改文件后重新导入。</div> : null}
              </div>
            </div>
          ) : (
            <Typography.Text type="secondary">全部导入成功。</Typography.Text>
          )}
        </div>
      ),
    });
  }

  async function handleImportChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    setImporting(true);
    try {
      const result = await api.postForm<BatchImportResult>('/ledger/import', formData);
      showImportResult(result);
      if (result.successCount > 0) {
        await reload(true);
      }
      message.success(`批量导入完成：成功 ${result.successCount} 行，失败 ${result.failureCount} 行`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '批量导入失败');
    } finally {
      setImporting(false);
    }
  }

  return (
    <Card
      title="派单台账"
      size="small"
      extra={
        <Space wrap>
          <Typography.Text className="desktop-header-description" type="secondary">全所共用一份台账，实时同步</Typography.Text>
          <Button size="small" icon={<DownloadOutlined />} onClick={() => setExportOpen(true)}>
            导出台账
          </Button>
          {isDirector ? (
            <Button
              size="small"
              icon={<DownloadOutlined />}
              onClick={() => void handleDownload('/ledger/import-template', '派单台账导入模板.xlsx')}
            >
              下载导入模板
            </Button>
          ) : null}
          {isDirector ? (
            <Button size="small" type="primary" icon={<UploadOutlined />} loading={importing} onClick={() => fileInputRef.current?.click()}>
              批量导入
            </Button>
          ) : null}
          {isSysadmin ? (
            <Button size="small" danger icon={<DeleteOutlined />} loading={preparingClear} onClick={() => void clearProjects()}>
              清空全部项目
            </Button>
          ) : null}
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void reload()}>
            刷新
          </Button>
          <Button size="small" icon={<AppstoreOutlined />} onClick={() => navigate('/board')}>
            项目看板
          </Button>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented<ViewMode>
          value={view}
          onChange={setView}
          options={[
            { value: 'project', label: '按项目' },
            { value: 'dispatch', label: '按派单记录' },
          ]}
        />
        <Input
          allowClear
          style={{ width: 240 }}
          prefix={<SearchOutlined />}
          placeholder="派单单号 / 派单项目名称 / 委托方 / 负责人"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Select
          allowClear
          style={{ width: 140 }}
          placeholder="交付成果类型"
          value={typeFilter}
          onChange={setTypeFilter}
          options={PROJECT_TYPES.map((t) => ({ value: t, label: t }))}
        />
        <Select
          allowClear
          style={{ width: 140 }}
          placeholder="主要承接部门"
          value={deptFilter}
          onChange={setDeptFilter}
          options={(departments ?? []).map((d) => ({ value: d.id, label: d.name }))}
        />
        <Select
          allowClear
          style={{ width: 140 }}
          placeholder={view === 'project' ? '项目状态' : '派单状态'}
          value={statusFilter}
          onChange={setStatusFilter}
          options={
            view === 'project'
              ? [
                  { value: 'pending', label: '待派单' },
                  { value: 'dispatched', label: '已派单' },
                  { value: 'done', label: '已完成' },
                  { value: 'terminated', label: '已撤销' },
                ]
              : (Object.keys(DISPATCH_STATUS_META) as DispatchStatus[]).map((key) => ({
                  value: key,
                  label: DISPATCH_STATUS_META[key].label,
                }))
          }
        />
      </Space>
      <div className="ledger-recent-filter">
        <Typography.Text type="secondary">项目创建日期：</Typography.Text>
        <Segmented<number>
          value={recentDays}
          onChange={setRecentDays}
          options={[
            { label: '全部', value: 0 },
            { label: '近5日', value: 5 },
            { label: '近15日', value: 15 },
            { label: '近30日', value: 30 },
          ]}
        />
        <Typography.Text type="secondary">包含今天</Typography.Text>
      </div>

      {view === 'project' ? (
        <Table<Project>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={projectRows}
          columns={sortableProjects}
          rowClassName={(project) => project.status === 'terminated' ? 'ledger-row-revoked' : (project.status !== 'done' && isOverdue(project.deadline, currentTime)) ? 'ledger-row-overdue' : ''}
          scroll={{ x: 2900 }}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 个项目` }}
          expandable={{
            expandedRowRender: (p) =>
              p.dispatches.length === 0 ? (
                <Typography.Text type="secondary">该项目还没有任何派单记录</Typography.Text>
              ) : (
                <div className="ledger-expand">
                  <Table<DispatchRecord>
                    rowKey="id"
                    size="small"
                    pagination={false}
                    dataSource={p.dispatches}
                    columns={sortableDispatches}
                    rowClassName={(dispatch) => dispatch.status === 'terminated' ? 'ledger-row-revoked' : ''}
                    scroll={{ x: 1400 }}
                  />
                </div>
              ),
          }}
        />
      ) : (
        <Table
          rowKey={(r) => String(r.dispatch.id)}
          size="small"
          loading={loading}
          dataSource={dispatchRows}
          columns={sortableDispatchView}
          rowClassName={(row) => row.dispatch.status === 'terminated' ? 'ledger-row-revoked' : (row.dispatch.status !== 'done' && isOverdue(row.project.deadline, currentTime)) ? 'ledger-row-overdue' : ''}
          scroll={{ x: 3050 }}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条派单记录` }}
        />
      )}

      <UpdateDispatchModal
        open={Boolean(editing)}
        dispatch={editing}
        onClose={() => setEditing(null)}
        onDone={() => void reload(true)}
      />
      <Modal
        open={exportOpen}
        title="导出台账"
        onCancel={() => setExportOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setExportOpen(false)}>取消</Button>,
          <Button key="active" onClick={() => { setExportOpen(false); void handleDownload('/ledger/export?includeRevoked=false', '派单台账.xlsx'); }}>去掉撤销导出</Button>,
          <Button key="all" type="primary" onClick={() => { setExportOpen(false); void handleDownload('/ledger/export?includeRevoked=true', '派单台账.xlsx'); }}>全部导出</Button>,
        ]}
      >
        是否连同已撤销项目和派单记录一起导出？导出范围为全部台账，不受当前筛选影响。
      </Modal>
      <ConfirmDestructiveModal
        open={Boolean(deleteAction)}
        title={deleteAction?.title ?? ''}
        description={deleteAction?.description}
        confirmationText={deleteAction?.confirmationText}
        okText={deleteAction?.okText}
        onCancel={() => setDeleteAction(null)}
        onConfirm={async (password, confirmation) => {
          if (!deleteAction) return;
          await deleteAction.submit(password, confirmation);
          message.success(deleteAction.successMessage);
          setDeleteAction(null);
          await reload(true);
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        style={{ display: 'none' }}
        onChange={handleImportChange}
      />
    </Card>
  );
}
