import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, Card, Checkbox, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import companyLogo from '../company-logo.png';

interface FormValues {
  username: string;
  password: string;
  remember: boolean;
}

export default function Login() {
  const { login } = useAuth();
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm<FormValues>();
  const [loading, setLoading] = useState(false);

  async function handleFinish(values: FormValues) {
    setLoading(true);
    try {
      await login(values.username.trim(), values.password, Boolean(values.remember));
      message.success('登录成功');
      navigate('/board', { replace: true });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
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
            <div><strong>中和金乾</strong><span>ZHONGHE JINQIAN</span></div>
          </div>
          <div className="login-intro-content">
            <span className="eyebrow">PROJECT DISPATCH PLATFORM</span>
            <h1>让每一次派单<br />更加清晰有序<span>。</span></h1>
            <p>连接部门与项目，让信息共享更及时，<br />项目安排更从容。</p>
            <div className="login-intro-rule" />
            <div className="login-intro-note">项目共享 <i /> 派单协同 <i /> 全程可溯</div>
          </div>
          <div className="login-intro-footer">资产评估项目派单管理平台</div>
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
            <div>中和金乾 · 项目派单管理平台</div>
            <div style={{ marginTop: 4 }}>版本 v2.0 · 设计者 Jade吕</div>
          </div>
        </Card>
      </div>
    </div>
  );
}
