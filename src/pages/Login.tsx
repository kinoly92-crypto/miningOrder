import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, Card, Checkbox, Form, Input, Modal, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import companyLogo from '../company-logo.png';

interface FormValues {
  username: string;
  password: string;
  remember: boolean;
}

interface ChangePasswordValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export default function Login() {
  const { login, changePassword } = useAuth();
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm<FormValues>();
  const [changeForm] = Form.useForm<ChangePasswordValues>();
  const [loading, setLoading] = useState(false);
  const [changeLoading, setChangeLoading] = useState(false);
  const [pendingUser, setPendingUser] = useState<{ username: string } | null>(null);

  async function handleFinish(values: FormValues) {
    setLoading(true);
    try {
      const user = await login(values.username.trim(), values.password, Boolean(values.remember));
      if (user.mustChangePassword) {
        setPendingUser({ username: user.username });
        changeForm.resetFields();
        return;
      }
      message.success('登录成功');
      navigate('/board', { replace: true });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleChangePassword(values: ChangePasswordValues) {
    if (!pendingUser) return;
    setChangeLoading(true);
    try {
      await changePassword(values.currentPassword, values.newPassword);
      message.success('密码已修改，请使用新密码重新登录');
      setPendingUser(null);
      changeForm.resetFields();
      form.setFieldsValue({ username: pendingUser.username, password: '' });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '密码修改失败');
    } finally {
      setChangeLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-shell">
        <section className="login-intro">
          <div className="login-brand">
            <a href="http://220.163.111.30:20600/" target="_blank" rel="noopener noreferrer" aria-label="打开中和金乾网站（新标签页）">
              <img src={companyLogo} alt="中和金乾公司标志" />
            </a>
            <div><strong>中和金乾-矿权</strong><span>ZHONGHE JINQIAN</span></div>
          </div>
          <div className="login-intro-content">
            <span className="eyebrow">PROJECT DISPATCH PLATFORM</span>
            <h1>让每一次派单<br />更加清晰有序<span>。</span></h1>
            <p>连接平台与项目，让信息共享更及时，<br />项目安排更从容。</p>
            <div className="login-intro-rule" />
            <div className="login-intro-note">项目共享 <i /> 派单协同 <i /> 全程可溯</div>
          </div>
          <div className="login-intro-footer">矿业权项目派单管理平台</div>
        </section>
        <Card className="login-card" bordered={false}>
          <div className="login-card-heading">
            <span className="eyebrow">WELCOME BACK</span>
            <Typography.Title level={3} className="login-title">欢迎登录</Typography.Title>
            <Typography.Text type="secondary" className="login-subtitle">请输入您的账号和密码，进入工作台</Typography.Text>
          </div>

        <Form form={form} layout="vertical" onFinish={handleFinish} initialValues={{ username: '', password: '', remember: false }}>
          <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
            <Input prefix={<UserOutlined />} placeholder="请输入账号" size="large" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="请输入密码"
              size="large"
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 12 }}>
            <Checkbox>保持登录 30 天（仅限个人设备）</Checkbox>
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button className="login-submit" type="primary" htmlType="submit" size="large" block loading={loading}>
              登录
            </Button>
          </Form.Item>
        </Form>
          <div className="login-card-footer">
            <div>矿业权项目派单管理平台</div>
            <div style={{ marginTop: 4 }}>版本 v1.0 设计者：Jade吕</div>
          </div>
        </Card>
      </div>

      <Modal
        title="首次登录：请修改初始密码"
        open={Boolean(pendingUser)}
        closable={false}
        maskClosable={false}
        footer={null}
      >
        <Typography.Paragraph type="secondary">
          当前账号使用初始密码登录，为保证账号安全，请先修改密码。修改完成后请使用新密码重新登录。
        </Typography.Paragraph>
        <Form form={changeForm} layout="vertical" onFinish={handleChangePassword}>
          <Form.Item
            name="currentPassword"
            label="当前密码（初始密码）"
            rules={[{ required: true, message: '请输入当前密码' }]}
          >
            <Input.Password autoComplete="current-password" maxLength={128} />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, max: 128, message: '新密码须为 6 至 128 位' },
            ]}
          >
            <Input.Password autoComplete="new-password" maxLength={128} />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value: string) {
                  return value === getFieldValue('newPassword')
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次输入的新密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" maxLength={128} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={changeLoading}>
              确认修改并重新登录
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
