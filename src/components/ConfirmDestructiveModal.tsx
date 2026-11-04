import { Alert, Input, Modal, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmationText?: string;
  okText?: string;
  onCancel: () => void;
  onConfirm: (password: string, confirmation: string) => Promise<void>;
}

export default function ConfirmDestructiveModal({
  open, title, description, confirmationText, okText = '确认删除', onCancel, onConfirm,
}: Props) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword('');
      setConfirmation('');
      setError('');
    }
  }, [open, title]);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await onConfirm(password, confirmation);
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      okText={okText}
      cancelText="取消"
      okButtonProps={{ danger: true, disabled: !password || Boolean(confirmationText && confirmation !== confirmationText) }}
      confirmLoading={busy}
      closable={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      onCancel={onCancel}
      onOk={() => void submit()}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert type="warning" showIcon message="此操作不可撤销，请先确认已有可恢复的备份。" description={description} />
        {confirmationText ? (
          <div>
            <Typography.Text>请输入“{confirmationText}”以确认：</Typography.Text>
            <Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </div>
        ) : null}
        <div>
          <Typography.Text>请输入当前管理员密码：</Typography.Text>
          <Input.Password
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {error ? <Alert type="error" showIcon message={error} /> : null}
      </Space>
    </Modal>
  );
}
