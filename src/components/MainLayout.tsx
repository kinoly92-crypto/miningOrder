import {
  AppstoreOutlined,
  AuditOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  PlusCircleOutlined,
  SettingOutlined,
  TableOutlined,
} from '@ant-design/icons';
import { App as AntdApp, Button, Drawer, Form, Input, Layout, Menu, Modal, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import companyLogo from '../company-logo.png';

interface AccountValues {
  username: string;
  currentPassword: string;
  newPassword?: string;
  confirmPassword?: string;
}

export default function MainLayout() {
  const { user, logout } = useAuth();
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [siderCollapsed, setSiderCollapsed] = useState(true);
  const [accountOpen, setAccountOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accountForm] = Form.useForm<AccountValues>();

  function openAccountSettings() {
    accountForm.resetFields();
    accountForm.setFieldsValue({ username: user?.username });
    setAccountOpen(true);
  }

  async function saveAccount(values: AccountValues) {
    setSaving(true);
    try {
      await api.patch('/auth/account', {
        username: values.username,
        currentPassword: values.currentPassword,
        ...(values.newPassword ? { newPassword: values.newPassword } : {}),
      });
      setAccountOpen(false);
      accountForm.resetFields();
      logout();
      navigate('/login', { replace: true });
      message.success('账号设置已更新，请重新登录');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '修改失败');
    } finally {
      setSaving(false);
    }
  }

  const menuItems = [
    { key: '/board', icon: <AppstoreOutlined />, label: '项目看板' },
    { key: '/ledger', icon: <TableOutlined />, label: '派单台账' },
    ...(user?.role === 'director' || user?.role === 'admin'
      ? [
          { key: '/dispatch/new', icon: <PlusCircleOutlined />, label: '派单登记' },
          { key: '/audit', icon: <AuditOutlined />, label: '操作日志' },
        ]
      : []),
  ];

  const selectedKey = menuItems.find((item) => location.pathname.startsWith(item.key))?.key ?? '/board';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider className="desktop-sider" theme="light" width={232} collapsedWidth={80} collapsed={siderCollapsed}>
        <div className="app-brand">
          <a href="http://220.163.111.30:20600/" target="_blank" rel="noopener noreferrer" aria-label="打开中和金乾网站（新标签页）">
            <img src={companyLogo} alt="中和金乾公司标志" className="app-brand-logo" />
          </a>
          {!siderCollapsed ? (
            <div className="app-brand-text">
              <strong>中和金乾</strong>
              <span>项目派单管理平台</span>
            </div>
          ) : null}
        </div>
        {!siderCollapsed ? <div className="nav-caption">WORKSPACE <span>工作台</span></div> : <div className="nav-caption-collapsed" />}
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: 'none' }}
        />
      </Layout.Sider>

      <Layout className="app-main">
        <Layout.Header className="app-header">
          <div className="app-header-title">
            <Button
              className="desktop-sider-toggle"
              type="text"
              icon={siderCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              aria-label={siderCollapsed ? '展开侧边菜单' : '收起侧边菜单'}
              aria-expanded={!siderCollapsed}
              onClick={() => setSiderCollapsed((collapsed) => !collapsed)}
            />
            <Button
              className="mobile-menu-button"
              type="text"
              icon={<MenuOutlined />}
              aria-label="打开导航菜单"
              onClick={() => setMenuOpen(true)}
            />
            <div className="header-location desktop-header-description">
              <span>工作台</span><span className="header-separator">/</span>
              <strong>{menuItems.find((item) => item.key === selectedKey)?.label}</strong>
            </div>
            <Typography.Text className="mobile-header-title" strong>中和金乾 · 派单平台</Typography.Text>
          </div>
          <Space size={8}>
            <span className="live-dot desktop-header-description">实时同步中</span>
            <Tag color={user?.role === 'admin' ? 'gold' : user?.role === 'director' ? 'blue' : 'default'}>
              {user?.role === 'admin' ? '管理员' : user?.role === 'director' ? '部门主任' : '只读账号'}
            </Tag>
            <Typography.Text strong>{user?.displayName}</Typography.Text>
            {user?.deptName ? <Typography.Text className="desktop-header-description" type="secondary">{user.deptName}</Typography.Text> : null}
            <Button type="text" icon={<SettingOutlined />} onClick={openAccountSettings}>账号设置</Button>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              onClick={() => {
                logout();
                navigate('/login');
              }}
            >
              退出
            </Button>
          </Space>
        </Layout.Header>

        <Layout.Content className="app-content">
          <Outlet />
        </Layout.Content>
      </Layout>
      <Drawer title="导航菜单" placement="left" width={240} open={menuOpen} onClose={() => setMenuOpen(false)}>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => {
            setMenuOpen(false);
            navigate(key);
          }}
          style={{ borderInlineEnd: 'none' }}
        />
      </Drawer>
      <Modal
        title="账号设置"
        open={accountOpen}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => accountForm.submit()}
        onCancel={() => setAccountOpen(false)}
      >
        <Typography.Paragraph type="secondary">修改账号或密码需要验证当前密码，保存后请重新登录。</Typography.Paragraph>
        <Form form={accountForm} layout="vertical" onFinish={saveAccount}>
          <Form.Item
            name="username"
            label="登录账号"
            rules={[
              { required: true, message: '请输入登录账号' },
              { pattern: /^[a-zA-Z0-9_]{3,32}$/, message: '账号须为 3 至 32 位英文字母、数字或下划线' },
            ]}
          >
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
            <Input.Password autoComplete="current-password" maxLength={128} />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码（不修改请留空）"
            rules={[{ min: 8, max: 128, message: '新密码须为 8 至 128 位' }]}
          >
            <Input.Password autoComplete="new-password" maxLength={128} />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              ({ getFieldValue }) => ({
                validator(_, value: string | undefined) {
                  return value === getFieldValue('newPassword') || (!value && !getFieldValue('newPassword'))
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次输入的新密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" maxLength={128} />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
}
