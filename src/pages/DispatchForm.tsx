import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { DispatchStatusTag } from '../components/StatusTag';
import { BUSINESS_LEVELS, EVALUATION_PURPOSES, PROJECT_TYPES, formatDateTime } from '../constants';
import type { BusinessLevel, ConflictInfo, Department, DispatchEntryInput, DispatchRecord, Project, ProjectType } from '../../shared/types';

interface FormValues {
  projectCode?: string;
  projectName: string;
  clientName?: string;
  clientContact?: string;
  clientPhone?: string;
  businessSource?: string;
  businessLevel?: BusinessLevel;
  projectType: ProjectType;
  evalPurpose?: string;
  estimatedFee?: number | null;
  deadline?: Dayjs | null;
  deptId?: number;
  assignee?: string;
  teamMembers?: string;
  signatoryOne?: string;
  signatoryTwo?: string;
  remark?: string;
}

interface LookupState {
  code: string;
  found: boolean;
  project: Project | null;
}

export default function DispatchForm() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [form] = Form.useForm<FormValues>();

  const [departments, setDepartments] = useState<Department[]>([]);
  const [lookup, setLookup] = useState<LookupState | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [succeeded, setSucceeded] = useState<Project | null>(null);
  const [similarProjects, setSimilarProjects] = useState<Project[]>([]);
  const [reviewValues, setReviewValues] = useState<FormValues | null>(null);
  const [detailProject, setDetailProject] = useState<Project | null>(null);

  const presetCode = searchParams.get('code') ?? '';
  const editMode = searchParams.get('mode') === 'edit';

  useEffect(() => {
    api
      .get<Department[]>('/departments')
      .then(setDepartments)
      .catch(() => setDepartments([]));
  }, []);

  const existing = lookup?.found ? lookup.project : null;
  const projectInfoDisabled = Boolean(existing) && !editMode;

  function applyProjectToForm(project: Project) {
    form.setFieldsValue({
      projectName: project.projectName,
      clientName: project.clientName ?? '',
      clientContact: project.clientContact ?? '',
      clientPhone: project.clientPhone ?? '',
      businessSource: project.businessSource ?? '',
      businessLevel: project.businessLevel ?? undefined,
      projectType: project.projectType,
      evalPurpose: project.evalPurpose ?? undefined,
      estimatedFee: project.estimatedFee ?? undefined,
      deadline: project.deadline ? dayjs(project.deadline) : null,
    });
  }

  /** 从台账或看板进入时读取指定项目，用于追加派单。 */
  async function runLookup(rawCode?: string) {
    const code = String(rawCode ?? form.getFieldValue('projectCode') ?? '').trim();
    if (!code) {
      setLookup(null);
      return;
    }
    if (lookup?.code === code) return;

    setChecking(true);
    try {
      const res = await api.get<{ found: boolean; project: Project | null }>(
        `/projects/lookup?code=${encodeURIComponent(code)}`,
      );
      setLookup({ code, found: res.found, project: res.project });
      if (res.found && res.project) {
        applyProjectToForm(res.project);
        setConflict(null);
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '派单单号查重失败');
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (!presetCode) return;
    form.setFieldValue('projectCode', presetCode);
    void runLookup(presetCode);
    // 仅在带参进入时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetCode]);

  async function saveEntry(values: FormValues) {
    setSubmitting(true);
    setConflict(null);
    setSucceeded(null);
    try {
      const dispatch = values.deptId && values.assignee?.trim() ? {
        deptId: values.deptId,
        assignee: values.assignee.trim(),
        teamMembers: values.teamMembers?.trim() || null,
        signatoryOne: values.signatoryOne?.trim() || null,
        signatoryTwo: values.signatoryTwo?.trim() || null,
        remark: values.remark?.trim() || null,
      } : undefined;
      // 已建档 -> 追加派单；未建档 -> 一并建档再派单
      const payload: DispatchEntryInput = existing
        ? { projectId: existing.id, dispatch }
        : {
              project: {
                projectName: values.projectName.trim(),
                clientName: values.clientName?.trim() || null,
                clientContact: values.clientContact?.trim() || null,
                clientPhone: values.clientPhone?.trim() || null,
                businessSource: values.businessSource?.trim() || null,
                businessLevel: values.businessLevel || null,
                projectType: values.projectType,
                evalPurpose: values.evalPurpose || null,
                estimatedFee: values.estimatedFee ?? null,
                deadline: values.deadline ? values.deadline.format('YYYY-MM-DD') : null,
              },
              dispatch,
            };

      const project = await api.post<Project>('/dispatches', payload);
      setSucceeded(project);
      setLookup(null);
      form.resetFields();
      message.success(dispatch ? '派单登记成功，台账已同步更新' : '待派单项目已登记');
    } catch (err) {
      if (err instanceof ApiError && err.conflict) {
        setConflict(err.conflict);
        // 冲突信息里带回了服务端的最新事实，直接同步到页面，避免主任看到过期信息
        if (err.conflict.project) {
          const latest = err.conflict.project;
          setLookup({ code: latest.projectCode, found: true, project: latest });
          applyProjectToForm(latest);
          form.setFieldValue('projectCode', latest.projectCode);
        }
        message.error(err.conflict.message);
      } else {
        message.error(err instanceof Error ? err.message : '派单登记失败');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function saveProjectEdit(values: FormValues) {
    if (!existing) return;
    setSubmitting(true);
    setConflict(null);
    try {
      await api.patch(`/projects/${existing.id}`, {
        projectName: values.projectName.trim(),
        clientName: values.clientName?.trim() || null,
        clientContact: values.clientContact?.trim() || null,
        clientPhone: values.clientPhone?.trim() || null,
        businessSource: values.businessSource?.trim() || null,
        businessLevel: values.businessLevel || null,
        projectType: values.projectType,
        evalPurpose: values.evalPurpose || null,
        estimatedFee: values.estimatedFee ?? null,
        deadline: values.deadline ? values.deadline.format('YYYY-MM-DD') : null,
        expectedUpdatedAt: existing.updatedAt,
      });
      message.success('项目信息已更新，台账已同步');
      navigate('/ledger');
    } catch (err) {
      if (err instanceof ApiError && err.conflict?.kind === 'stale-record') {
        message.error(err.conflict.message);
      } else {
        message.error(err instanceof Error ? err.message : '修改失败');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleFinish(values: FormValues) {
    if (editMode) {
      if (!existing) {
        message.error('未找到要修改的项目，请从台账重新进入');
        return;
      }
      await saveProjectEdit(values);
      return;
    }
    if (!values.deptId && [values.teamMembers, values.signatoryOne, values.signatoryTwo].some((value) => value?.trim())) {
      message.error('项目组成员和签字评估师属于派单信息，请先填写主要承接部门和负责人');
      return;
    }
    if (existing) {
      await saveEntry(values);
      return;
    }
    setSubmitting(true);
    try {
      const matches = await api.get<Project[]>(`/projects/similar?name=${encodeURIComponent(values.projectName.trim())}`);
      if (matches.length > 0) {
        setSimilarProjects(matches);
        setReviewValues(values);
      } else {
        await saveEntry(values);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '项目名称查重失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  const existingDispatchColumns: ColumnsType<DispatchRecord> = [
    { title: '主要承接部门', dataIndex: 'deptName', width: 140 },
    { title: '项目负责人', dataIndex: 'assignee', width: 120 },
    { title: '派单人', dataIndex: 'dispatcherName', width: 100 },
    { title: '派单时间', dataIndex: 'dispatchedAt', width: 160, render: (v: string) => formatDateTime(v) },
    { title: '状态', dataIndex: 'status', width: 100, render: (s: DispatchRecord['status']) => <DispatchStatusTag status={s} /> },
    { title: '备注', dataIndex: 'remark', render: (v: string | null) => v || '—' },
  ];

  return (
    <Card
      title="派单登记"
      size="small"
      extra={
        <Button size="small" onClick={() => navigate('/ledger')}>
          查看派单台账
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={editMode ? '修改项目基本信息' : '新建项目时将按项目名称检查疑似重复'}
        description={editMode ? '修改后将立即同步到台账；派单单号不可修改。' : '提交前会提示名称相似的项目；派单单号自动生成。待派单项目可同时留空主要承接部门和负责人，正式派单时两项均需填写。'}
      />

      {conflict ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="本次派单未成功"
          description={conflict.message}
        />
      ) : null}

      {succeeded ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
          message="派单登记成功"
          description={`派单单号 ${succeeded.projectCode}《${succeeded.projectName}》已登记，当前共 ${succeeded.dispatches.length} 条派单记录。`}
        />
      ) : null}

      {existing ? (
        <div style={{ marginBottom: 16 }}>
          {editMode ? (
            <Alert
              type="warning"
              showIcon
              message={`正在修改 ${existing.projectCode}《${existing.projectName}》`}
              description="修改保存后将立即同步到台账。"
            />
          ) : (
            <>
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={`派单单号 ${existing.projectCode} 已建档，当前为「追加派单」模式`}
                description="项目基本信息已自动带出且不可修改，可继续为其他部门追加派单。"
              />
              <Table<DispatchRecord>
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={existing.dispatches}
                columns={existingDispatchColumns}
                scroll={{ x: 750 }}
                locale={{ emptyText: '该项目尚未派单，请填写下方承接信息后提交' }}
              />
              <Divider style={{ margin: '16px 0 0' }} />
            </>
          )}
        </div>
      ) : null}

      <Form
        form={form}
        layout="vertical"
        onFinish={handleFinish}
        initialValues={{ projectType: '资产评估报告' }}
        disabled={submitting}
      >
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          一、项目信息
        </Typography.Title>
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item
              name="projectCode"
              label="派单单号"
              validateStatus={checking ? 'validating' : undefined}
              hasFeedback={checking}
              extra="新建时由系统自动生成；追加派单请从台账选择已有项目"
            >
              <Input
                placeholder="提交时自动生成"
                maxLength={40}
                disabled
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item
              name="projectName"
              label="派单项目名称"
              rules={[
                { required: true, whitespace: true, message: '请输入派单项目名称' },
                {
                  validator: (_, value: string | undefined) =>
                    existing || (value ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').length >= 2
                      ? Promise.resolve()
                      : Promise.reject(new Error('项目名称需包含至少两个文字或字符')),
                },
              ]}
            >
              <Input placeholder="例如 ××有限公司股东全部权益价值评估" maxLength={120} disabled={projectInfoDisabled} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="clientName" label="委托方">
              <Input placeholder="委托单位名称" maxLength={80} disabled={projectInfoDisabled} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item name="clientContact" label="委托方联系人">
              <Input placeholder="联系人姓名" maxLength={100} disabled={projectInfoDisabled} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="clientPhone" label="委托方联系电话">
              <Input placeholder="手机或固定电话" maxLength={60} disabled={projectInfoDisabled} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item name="businessSource" label="业务来源">
              <Input placeholder="例如 银行推荐、老客户、招标中标" maxLength={200} disabled={projectInfoDisabled} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="businessLevel" label="业务程度">
              <Select
                allowClear
                placeholder="请选择业务程度"
                options={BUSINESS_LEVELS.map((level) => ({ value: level, label: level }))}
                disabled={projectInfoDisabled}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} sm={12} lg={6}>
            <Form.Item name="projectType" label="交付成果类型" rules={[{ required: true, message: '请选择本次交付成果的类型' }]}>
              <Select placeholder="请选择本次交付成果的类型" options={PROJECT_TYPES.map((t) => ({ value: t, label: t }))} disabled={projectInfoDisabled} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Form.Item name="evalPurpose" label="评估目的">
              <Select
                allowClear
                placeholder="请选择评估目的"
                options={[
                  ...EVALUATION_PURPOSES.map((purpose) => ({ value: purpose, label: purpose })),
                  ...(existing?.evalPurpose && !EVALUATION_PURPOSES.includes(existing.evalPurpose)
                    ? [{ value: existing.evalPurpose, label: existing.evalPurpose }]
                    : []),
                ]}
                disabled={projectInfoDisabled}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Form.Item name="estimatedFee" label="预估收费（元）">
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={1000}
                placeholder="例如 85000"
                disabled={projectInfoDisabled}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Form.Item name="deadline" label="要求完成时间">
              <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" disabled={projectInfoDisabled} />
            </Form.Item>
          </Col>
        </Row>

        {!editMode && (
          <>
            <Divider />

            <Typography.Title level={5}>二、派单信息</Typography.Title>
        <Row gutter={16}>
          <Col xs={24} sm={12} lg={6}>
            <Form.Item
              name="deptId"
              label="主要承接部门"
              dependencies={['assignee']}
              rules={[({ getFieldValue }) => ({
                validator: (_, value) => value || (!existing && !getFieldValue('assignee')?.trim())
                  ? Promise.resolve() : Promise.reject(new Error('请选择主要承接部门')),
              })]}
            >
              <Select
                allowClear
                placeholder="请选择"
                options={(departments ?? []).map((d) => ({ value: d.id, label: d.name }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Form.Item
              name="assignee"
              label="项目负责人"
              dependencies={['deptId']}
              rules={[({ getFieldValue }) => ({
                validator: (_, value: string | undefined) => {
                  const name = value?.trim() ?? '';
                  if (!name && (existing || getFieldValue('deptId'))) return Promise.reject(new Error('请填写一位项目负责人'));
                  if (/[\s,，、;；/／]/.test(name)) return Promise.reject(new Error('每条派单只能填写一位负责人，姓名中不能包含空格或分隔符'));
                  return Promise.resolve();
                },
              })]}
            >
              <Input placeholder="填写一位负责人姓名" maxLength={40} />
            </Form.Item>
          </Col>
          <Col xs={24} lg={12}>
            <Form.Item name="remark" label="备注">
              <Input placeholder="例如 两部门协作、进场时间约定等" maxLength={200} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col xs={24} lg={12}>
            <Form.Item name="teamMembers" label="项目组成员" extra="多人请用分号隔开，例如：张三；李四">
              <Input placeholder="项目组成员，使用分号隔开" maxLength={500} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Form.Item name="signatoryOne" label="签字评估师一">
              <Input placeholder="签字评估师姓名" maxLength={80} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Form.Item name="signatoryTwo" label="签字评估师二">
              <Input placeholder="签字评估师姓名" maxLength={80} />
            </Form.Item>
          </Col>
        </Row>
          </>
        )}

        <Space>
          <Button type="primary" htmlType="submit" loading={submitting}>
            {editMode ? '保存修改' : '提交派单登记'}
          </Button>
          <Button
            onClick={() => {
              form.resetFields();
              setLookup(null);
              setConflict(null);
              setSucceeded(null);
            }}
          >
            重置
          </Button>
        </Space>
      </Form>
      <Modal
        title="发现疑似重复项目"
        open={Boolean(reviewValues)}
        onCancel={() => setReviewValues(null)}
        footer={[
          <Button key="yes" onClick={() => { setReviewValues(null); navigate('/ledger'); }}>是，退出新建</Button>,
          <Button key="no" type="primary" onClick={() => {
            const values = reviewValues;
            setReviewValues(null);
            if (values) void saveEntry(values);
          }}>否，继续创建</Button>,
        ]}
      >
        <Typography.Paragraph>当前台账中有名称相似的项目，请点击派单单号查看详情后，判断是否为重复项目。</Typography.Paragraph>
        <div className="similar-project-list">
          {similarProjects.map((project) => (
            <div key={project.id}>
              <Button type="link" onClick={() => setDetailProject(project)}>{project.projectCode}</Button>
              <span>{project.projectName}</span>
            </div>
          ))}
        </div>
        <Typography.Text strong>是否为重复项目？</Typography.Text>
      </Modal>
      <Modal title="疑似项目基本信息" open={Boolean(detailProject)} onCancel={() => setDetailProject(null)} footer={<Button onClick={() => setDetailProject(null)}>关闭</Button>} width={720}>
        {detailProject ? (
          <>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="派单单号">{detailProject.projectCode}</Descriptions.Item>
              <Descriptions.Item label="派单项目名称">{detailProject.projectName}</Descriptions.Item>
              <Descriptions.Item label="委托方">{detailProject.clientName || '—'}</Descriptions.Item>
              <Descriptions.Item label="委托方联系人">{detailProject.clientContact || '—'}</Descriptions.Item>
              <Descriptions.Item label="委托方联系电话">{detailProject.clientPhone || '—'}</Descriptions.Item>
              <Descriptions.Item label="交付成果类型">{detailProject.projectType}</Descriptions.Item>
              <Descriptions.Item label="评估目的">{detailProject.evalPurpose || '—'}</Descriptions.Item>
              <Descriptions.Item label="创建日期">{formatDateTime(detailProject.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="要求完成时间">{detailProject.deadline || '—'}</Descriptions.Item>
            </Descriptions>
            <Table<DispatchRecord> style={{ marginTop: 16 }} rowKey="id" size="small" pagination={false} dataSource={detailProject.dispatches} columns={existingDispatchColumns} scroll={{ x: 750 }} />
          </>
        ) : null}
      </Modal>
    </Card>
  );
}
