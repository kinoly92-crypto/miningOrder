import { App as AntdApp, DatePicker, Form, Input, Modal, Select, Typography } from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { DISPATCH_STATUS_META, formatDateTime } from '../constants';
import type { DispatchRecord, DispatchStatus } from '../../shared/types';

interface Props {
  open: boolean;
  dispatch: DispatchRecord | null;
  onClose: () => void;
  onDone?: () => void;
}

interface FormValues {
  status: DispatchStatus;
  assignee: string;
  teamMembers?: string;
  signatoryOne?: string;
  signatoryTwo?: string;
  actualCompletionDate?: Dayjs | null;
  remark?: string;
}

export default function UpdateDispatchModal({ open, dispatch, onClose, onDone }: Props) {
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);
  const completionDate = Form.useWatch('actualCompletionDate', form);
  const status = Form.useWatch('status', form);

  useEffect(() => {
    if (open && dispatch) {
      form.setFieldsValue({
        status: dispatch.status,
        assignee: dispatch.assignee,
        teamMembers: dispatch.teamMembers ?? '',
        signatoryOne: dispatch.signatoryOne ?? '',
        signatoryTwo: dispatch.signatoryTwo ?? '',
        actualCompletionDate: dispatch.actualCompletionDate ? dayjs(dispatch.actualCompletionDate) : null,
        remark: dispatch.remark ?? '',
      });
    }
  }, [open, dispatch, form]);

  // 填写了实际完成日期后，自动把状态置为「已完成」；状态仍可手动改回。
  useEffect(() => {
    if (completionDate) form.setFieldValue('status', 'done');
  }, [completionDate, form]);

  async function handleFinish(values: FormValues) {
    if (!dispatch) return;
    setSaving(true);
    try {
      await api.patch(`/dispatches/${dispatch.id}`, {
        status: values.status,
        assignee: values.assignee,
        teamMembers: values.teamMembers ?? null,
        signatoryOne: values.signatoryOne ?? null,
        signatoryTwo: values.signatoryTwo ?? null,
        actualCompletionDate: values.actualCompletionDate ? values.actualCompletionDate.format('YYYY-MM-DD') : null,
        remark: values.remark ?? null,
        // 乐观并发控制：带上打开弹窗时的版本，被别人抢先改过就拒绝写入
        expectedUpdatedAt: dispatch.updatedAt,
      });
      message.success('派单记录已更新，其他主任的台账已同步刷新');
      onDone?.();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.conflict?.kind === 'stale-record') {
        modal.warning({ title: '记录已被其他主任修改', content: err.conflict.message });
        onDone?.();
      } else {
        message.error(err instanceof Error ? err.message : '更新失败');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title="维护派单记录"
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => form.submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      {dispatch ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          {dispatch.projectCode}《{dispatch.projectName}》 —— {dispatch.deptName}
          <br />
          派单人 {dispatch.dispatcherName}，派单时间 {formatDateTime(dispatch.dispatchedAt)}
        </Typography.Paragraph>
      ) : null}

      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <Form.Item name="status" label="派单状态" rules={[{ required: true, message: '请选择状态' }]}>
          <Select
            options={(Object.keys(DISPATCH_STATUS_META) as DispatchStatus[]).map((key) => ({
              value: key,
              label: DISPATCH_STATUS_META[key].label,
            }))}
            onChange={(value: DispatchStatus) => {
              if (value !== 'done') form.setFieldValue('actualCompletionDate', null);
            }}
          />
        </Form.Item>
        <Form.Item name="assignee" label="项目负责人" rules={[
          { required: true, whitespace: true, message: '请填写项目负责人' },
          { pattern: /^\s*[^\s,，、;；/／]+\s*$/, message: '每条派单只能填写一位负责人，姓名中不能包含空格或分隔符' },
        ]}>
          <Input placeholder="请输入承接该项目的负责人姓名" maxLength={40} />
        </Form.Item>
        <Form.Item name="teamMembers" label="项目组成员" extra="多人请用分号隔开，例如：张三；李四">
          <Input maxLength={500} placeholder="项目组成员" />
        </Form.Item>
        <Form.Item name="signatoryOne" label="签字评估师一">
          <Input maxLength={80} />
        </Form.Item>
        <Form.Item name="signatoryTwo" label="签字评估师二">
          <Input maxLength={80} />
        </Form.Item>
        <Form.Item
          name="actualCompletionDate"
          label="实际完成日期"
          rules={[
            ...(status === 'done' ? [{ required: true, message: '状态为已完成时，请填写实际完成日期' }] : []),
            {
              validator: (_rule, value) => {
                if (status !== 'done' && value) {
                  return Promise.reject(new Error('项目为未完成项目，实际完成时间必须为空值'));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" placeholder="选择实际完成日期" />
        </Form.Item>
        <Form.Item name="remark" label="备注">
          <Input.TextArea rows={3} maxLength={200} showCount placeholder="例如：现场勘查安排、协作说明等" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
