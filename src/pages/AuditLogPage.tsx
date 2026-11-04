import { DeleteOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, Card, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ConfirmDestructiveModal from '../components/ConfirmDestructiveModal';
import { AUDIT_ACTION_META, formatDateTime } from '../constants';
import { useLiveData } from '../hooks/useLiveData';
import type { AuditLog } from '../../shared/types';

export default function AuditLogPage() {
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const isSysadmin = user?.role === 'admin' && user.username === 'sysadmin';
  const { data, loading, reload } = useLiveData(() => api.get<AuditLog[]>('/audit-logs?limit=300'));
  const [exporting, setExporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const logs = data ?? [];

  async function exportLogs() {
    setExporting(true);
    try {
      const { blob, filename } = await api.download('/audit-logs/export');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename ?? '操作日志.xlsx';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      message.success('操作日志已开始下载');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }

  const columns: ColumnsType<AuditLog> = [
    { title: '时间', dataIndex: 'createdAt', width: 170, render: (v: string) => formatDateTime(v) },
    { title: '操作人', dataIndex: 'userName', width: 140, render: (v: string | null) => v ?? '—' },
    {
      title: '操作类型',
      dataIndex: 'action',
      width: 130,
      render: (action: string) => {
        const meta = AUDIT_ACTION_META[action];
        return <Tag color={meta?.color ?? 'default'}>{meta?.label ?? action}</Tag>;
      },
    },
    { title: '操作内容', dataIndex: 'detail', render: (v: string | null) => v ?? '—' },
  ];

  return (
    <Card
      title="操作日志"
      size="small"
      extra={
        <Space wrap>
          <Button size="small" icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportLogs()}>
            导出日志
          </Button>
          {isSysadmin ? (
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setClearing(true)}>
              清空操作日志
            </Button>
          ) : null}
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void reload()}>
            刷新
          </Button>
        </Space>
      }
    >
      <Typography.Text type="secondary">页面显示最近 300 条，导出包含全部历史日志。</Typography.Text>
      <Table<AuditLog>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={logs}
        columns={columns}
        scroll={{ x: 700 }}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 条日志` }}
      />
      <ConfirmDestructiveModal
        open={clearing}
        title="清空操作日志"
        description="将删除全部历史操作日志，而不只是当前页面显示的 300 条；建议先导出备份。清空后会保留一条本次清空的记录。"
        confirmationText="清空操作日志"
        okText="确认清空"
        onCancel={() => setClearing(false)}
        onConfirm={async (password, confirmation) => {
          await api.post('/admin/audit-logs/clear', { password, confirmation });
          setClearing(false);
          message.success('操作日志已清空，保留本次清空记录');
          await reload(true);
        }}
      />
    </Card>
  );
}
