import { Alert, App as AntdApp, Button, Card, Col, Empty, Row, Segmented, Space, Statistic, Table, Tag, Typography } from 'antd';
import { AlertOutlined, AppstoreOutlined, CheckCircleOutlined, ClockCircleOutlined, FileTextOutlined, PlusCircleOutlined, ReloadOutlined, RiseOutlined, WarningOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import dayjs from 'dayjs';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { BOARD_CARD_LIMIT, boardCardExtraPadding } from '../board-layout';
import UpdateDispatchModal from '../components/UpdateDispatchModal';
import { BOARD_COLUMNS, PROJECT_TYPES, deadlineRemaining, formatDate, formatDateTime, formatFee, isCreatedWithinDays, isOverdue } from '../constants';
import { useLiveData } from '../hooks/useLiveData';
import type { DeptStat, DispatchRecord, Project, StatsOverview } from '../../shared/types';

interface BoardCardListProps {
  children: ReactNode;
  count: number;
  title: string;
  boardHeight: number;
  naturalHeight: number;
  onMeasure: (title: string, height: number) => void;
  columns?: number;
}

function BoardCardList({ children, count, title, boardHeight, naturalHeight, onMeasure, columns = 1 }: BoardCardListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const limit = BOARD_CARD_LIMIT * columns;
  const extraPerCard = boardCardExtraPadding(count, naturalHeight, boardHeight, columns);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || count === 0) {
      onMeasure(title, 0);
      return;
    }

    const cards = Array.from(list.querySelectorAll<HTMLElement>('.board-card')).slice(0, limit);
    const measure = () => {
      const extra = parseFloat(getComputedStyle(list).getPropertyValue('--board-card-extra')) || 0;
      let total = 0;
      if (columns > 1) {
        const rowGap = parseFloat(getComputedStyle(list).rowGap) || 0;
        for (let i = 0; i < cards.length; i += columns) {
          const row = cards.slice(i, i + columns);
          const rowHeight = Math.ceil(Math.max(...row.map((card) => card.getBoundingClientRect().height - extra)) - 0.01);
          total += rowHeight + rowGap;
        }
        total -= rowGap;
      } else {
        total = cards.reduce((sum, card) =>
          sum + card.getBoundingClientRect().height - extra + (parseFloat(getComputedStyle(card).marginBottom) || 0), 0);
      }
      onMeasure(title, Math.ceil(total - 0.01));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    cards.forEach((card) => observer.observe(card));
    measure();
    return () => observer.disconnect();
  }, [children, count, onMeasure, title, columns, limit]);

  return (
    <div
      ref={listRef}
      className={`board-card-list${columns > 1 && count > 0 ? ' board-card-list--grid' : ''}${count === 0 ? ' board-card-list-empty' : ''}`}
      style={{
        height: boardHeight || undefined,
        '--board-card-extra': `${extraPerCard}px`,
        '--board-card-padding': `${12 + extraPerCard / 2}px`,
      } as CSSProperties}
      role={count > 0 ? 'region' : undefined}
      aria-label={count > 0 ? `${title}记录列表，可上下滚动` : undefined}
      tabIndex={count > 0 ? 0 : undefined}
    >
      {children}
    </div>
  );
}

export default function Board() {
  const { user } = useAuth();
  const { modal, message } = AntdApp.useApp();
  const navigate = useNavigate();
  const isDirector = user?.role === 'director' || user?.role === 'admin';

  const { data, loading, error, reload } = useLiveData(() => api.get<Project[]>('/projects'));
  const { data: stats } = useLiveData(() => api.get<StatsOverview>('/stats'));
  const [editing, setEditing] = useState<DispatchRecord | null>(null);
  const [currentTime, setCurrentTime] = useState(() => dayjs());
  const [boardRecentDays, setBoardRecentDays] = useState(0);
  const [columnHeights, setColumnHeights] = useState<Record<string, number>>({});
  const reportColumnHeight = useCallback((title: string, height: number) => {
    setColumnHeights((current) => current[title] === height ? current : { ...current, [title]: height });
  }, []);
  const boardListHeight = Math.max(0, ...Object.values(columnHeights));

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(dayjs()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const projects = data ?? [];
  const boardProjects = projects.filter((p) =>
    !boardRecentDays || isCreatedWithinDays(p.createdAt, boardRecentDays, currentTime));
  const pending = boardProjects.filter((p) => p.status === 'pending');
  const assignedProjects = projects.filter((p) => p.status === 'dispatched' || p.status === 'done');
  const typeNames: string[] = [...PROJECT_TYPES];
  for (const project of projects) {
    if (!typeNames.includes(project.projectType)) typeNames.push(project.projectType);
  }
  const typeCounts = typeNames.map((name) => ({
    name,
    count: assignedProjects.filter((project) => project.projectType === name).length,
  }));
  const assigneeCounts = new Map<string, number>();
  for (const project of projects) {
    for (const dispatch of project.dispatches) {
      const name = dispatch.assignee.trim();
      if (dispatch.status !== 'terminated' && name) {
        assigneeCounts.set(name, (assigneeCounts.get(name) ?? 0) + 1);
      }
    }
  }
  const assigneeRanking = Array.from(assigneeCounts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
  const maxAssigneeCount = assigneeRanking[0]?.count ?? 0;
  const overdueProjects = projects.filter((p) =>
    p.status !== 'done' && p.status !== 'terminated' && isOverdue(p.deadline, currentTime));
  const upcomingProjects = projects.filter((p) => {
    if (p.status === 'done' || p.status === 'terminated' || !p.deadline) return false;
    const days = dayjs(p.deadline).startOf('day').diff(currentTime.startOf('day'), 'day');
    return days >= 0 && days <= 3;
  });

  function revoke(record: DispatchRecord) {
    modal.confirm({
      title: '确认撤销这条派单？',
      content: `${record.deptName} 承接的「${record.projectName}」将被标记为已撤销。记录仍保留在台账与操作日志中可追溯，该平台可以重新承接该项目。`,
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

  return (
    <div className="dashboard">
      <div className="dashboard-heading">
        <div>
          <div className="eyebrow">PROJECT OVERVIEW <span> / 项目总览</span></div>
          <h1>项目派单工作台</h1>
          <p>掌握项目动态，协同安排每一项工作。</p>
        </div>
        {isDirector ? (
          <Button type="primary" icon={<PlusCircleOutlined />} onClick={() => navigate('/dispatch/new')}>
            新建派单
          </Button>
        ) : null}
      </div>

      <Row gutter={[16, 16]} className="section-card dashboard-stats">
        <Col xs={12} sm={8} lg={6}>
          <Link className="dashboard-stat-link" to="/ledger" aria-label="查看全部评估项目台账">
            <Card size="small">
              <div className="stat-icon"><FileTextOutlined /></div>
              <Statistic title="评估项目总数" value={stats?.totalProjects ?? 0} suffix="个" />
            </Card>
          </Link>
        </Col>
        <Col xs={12} sm={8} lg={6}>
          <Link className="dashboard-stat-link" to="/ledger?status=pending" aria-label="查看待派单项目台账">
            <Card size="small">
              <div className="stat-icon stat-icon-gold"><ClockCircleOutlined /></div>
              <Statistic title="待派单项目" value={stats?.pendingProjects ?? 0} suffix="个" />
            </Card>
          </Link>
        </Col>
        <Col xs={12} sm={8} lg={6}>
          <Link className="dashboard-stat-link" to="/ledger?status=dispatched" aria-label="查看在办项目台账">
            <Card size="small">
              <div className="stat-icon"><AppstoreOutlined /></div>
              <Statistic title="在办项目" value={stats?.activeProjects ?? 0} suffix="个" />
            </Card>
          </Link>
        </Col>
        <Col xs={12} sm={8} lg={6}>
          <Link className="dashboard-stat-link" to="/ledger?status=done" aria-label="查看已完成项目台账">
            <Card size="small">
              <div className="stat-icon stat-icon-green"><CheckCircleOutlined /></div>
              <Statistic title="已完成" value={stats?.doneProjects ?? 0} suffix="个" />
            </Card>
          </Link>
        </Col>
        <Col xs={12} sm={8} lg={6}>
          <Link className="dashboard-stat-link" to="/ledger?status=terminated" aria-label="查看已撤销项目台账">
            <Card size="small">
              <div className="stat-icon"><ClockCircleOutlined /></div>
              <Statistic title="已撤销项目" value={stats?.terminatedProjects ?? 0} suffix="个" />
            </Card>
          </Link>
        </Col>
        <Col xs={12} sm={8} lg={6}>
          <Link className="dashboard-stat-link" to="/ledger?view=dispatch" aria-label="查看本月派单台账">
            <Card size="small">
              <div className="stat-icon stat-icon-gold"><RiseOutlined /></div>
              <Statistic title="本月派单量" value={stats?.monthDispatched ?? 0} suffix="次" />
            </Card>
          </Link>
        </Col>
        <Col xs={12} sm={8} lg={6}>
          <Link className="dashboard-stat-link" to="/ledger?deadline=overdue" aria-label="查看超期项目台账">
            <Card size="small">
              <div className="stat-icon"><WarningOutlined /></div>
              <Statistic title="超期项目" value={overdueProjects.length} suffix="个" />
            </Card>
          </Link>
        </Col>
        <Col xs={12} sm={8} lg={6}>
          <Link className="dashboard-stat-link" to="/ledger?deadline=upcoming" aria-label="查看即将到期项目台账">
            <Card size="small">
              <div className="stat-icon stat-icon-gold"><AlertOutlined /></div>
              <Statistic title="即将到期项目" value={upcomingProjects.length} suffix="个" />
            </Card>
          </Link>
        </Col>
      </Row>

      <Card className="section-card type-card" size="small" title="交付成果类型分布" extra={<span className="section-hint">仅统计有效派单的项目 · 每个项目计一次</span>} loading={loading}>
        {error ? (
          <Alert type="error" showIcon message="交付成果类型数据加载失败" description={error} />
        ) : (
          <div className="type-overview">
            <div className="type-summary">
              <span>已派单项目总数</span>
              <strong>{data ? assignedProjects.length : '—'}<small> 个</small></strong>
              <p>各交付成果类型项目构成</p>
            </div>
            <div className="type-grid">
              {typeCounts.map(({ name, count }, index) => (
                <div className="type-item" key={name}>
                  <div className="type-item-heading">
                    <span><i className={`type-dot type-color-${index % 7}`} />{name}</span>
                    <strong>{count} <small>个</small></strong>
                  </div>
                  <div className="type-track" aria-hidden="true">
                    <div className={`type-fill type-color-${index % 7}`} style={{ width: `${assignedProjects.length ? (count / assignedProjects.length) * 100 : 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card
        className="section-card dispatch-board"
        size="small"
        title="项目派单看板"
        extra={
          <Space wrap>
            <Typography.Text className="desktop-header-description" type="secondary">数据实时同步，任何主任派单后此处自动刷新</Typography.Text>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void reload()}>
              刷新
            </Button>
            {isDirector ? (
              <Button size="small" type="primary" icon={<PlusCircleOutlined />} onClick={() => navigate('/dispatch/new')}>
                派单登记
              </Button>
            ) : null}
          </Space>
        }
        loading={loading}
      >
        <div className="board-recent-filter">
          <Typography.Text type="secondary">项目创建日期：</Typography.Text>
          <Segmented<number>
            value={boardRecentDays}
            onChange={setBoardRecentDays}
            options={[
              { label: '近5天', value: 5 },
              { label: '近15天', value: 15 },
              { label: '近1个月', value: 30 },
              { label: '全部', value: 0 },
            ]}
          />
          <Typography.Text type="secondary">包含今天，近1个月按30天计算</Typography.Text>
        </div>
        <div className="board-wrap">
          {/* 待派单与撤销状态分开展示。 */}
          <div className="board-column">
            <div className="board-column-head">
              <span>
                <Tag color="orange">待派单</Tag>
              </span>
              <span>{pending.length}</span>
            </div>
            <BoardCardList
              count={pending.length}
              title="待派单"
              boardHeight={boardListHeight}
              naturalHeight={columnHeights['待派单'] ?? 0}
              onMeasure={reportColumnHeight}
            >
            {pending.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待派单项目" />
            ) : (
              pending.map((project) => (
                <div
                  key={project.id}
                  className={`board-card${isOverdue(project.deadline, currentTime) ? ' board-card-overdue' : ''}`}
                  onClick={() => isDirector && navigate(`/ledger?code=${encodeURIComponent(project.projectCode)}`)}
                  title={isDirector ? '点击查看该项目台账' : undefined}
                >
                  <div className="board-card-code">{project.projectCode}</div>
                  <div className="board-card-name">{project.projectName}</div>
                  {isOverdue(project.deadline, currentTime) ? <Tag color="red">已超时</Tag> : null}
                  <div className="board-card-meta">
                    <div>委托方：{project.clientName ?? '—'}</div>
                    <div>委托方联系人：{project.clientContact || '—'}</div>
                    <div>委托方联系电话：{project.clientPhone || '—'}</div>
                    <div>交付成果类型：<strong className="board-card-type">{project.projectType}</strong></div>
                    <div>要求完成：{formatDate(project.deadline)}</div>
                    <div className="board-card-deadline">剩余工期：<span className={deadlineRemaining(project.deadline, currentTime).urgent ? 'board-card-deadline-urgent' : ''}>{deadlineRemaining(project.deadline, currentTime).label}</span></div>
                    <div>预估收费：<strong className="board-card-fee">{formatFee(project.estimatedFee)}</strong></div>
                  </div>
                  {isDirector ? (
                    <div style={{ marginTop: 8 }}>
                      <Button size="small" type="primary" onClick={(e) => { e.stopPropagation(); navigate(`/dispatch/new?code=${encodeURIComponent(project.projectCode)}`); }}>
                        派单
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
            </BoardCardList>
          </div>

          {BOARD_COLUMNS.map((column) => {
            const items = boardProjects.flatMap((project) =>
              project.dispatches.filter((d) => d.status === column.key).map((dispatch) => ({ project, dispatch })),
            );
            const revokedWithoutDispatch = column.key === 'terminated'
              ? boardProjects.filter((project) => project.status === 'terminated' && project.dispatches.length === 0)
              : [];
            const count = items.length + revokedWithoutDispatch.length;
            return (
              <div className={`board-column${column.wide ? ' board-column-wide' : ''}`} key={column.key}>
                <div className="board-column-head">
                  <span>
                    <Tag color={column.key === 'done' ? 'green' : column.key === 'terminated' ? 'default' : 'blue'}>
                      {column.title}
                    </Tag>
                  </span>
                  <span>{count}</span>
                </div>
                <BoardCardList
                  count={count}
                  title={column.title}
                  boardHeight={boardListHeight}
                  naturalHeight={columnHeights[column.title] ?? 0}
                  onMeasure={reportColumnHeight}
                  columns={column.wide ? 2 : 1}
                >
                {count === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无记录" />
                ) : (
                  <>
                  {items.map(({ project, dispatch }) => (
                    <div
                      key={dispatch.id}
                      className={`board-card${dispatch.status === 'terminated' ? ' board-card-revoked' : dispatch.status === 'done' ? ' board-card-done' : (isOverdue(project.deadline, currentTime) ? ' board-card-overdue' : '')}`}
                      onClick={() => {
                        if (!isDirector) return;
                        if (dispatch.status === 'terminated') setEditing(dispatch);
                        else navigate(`/ledger?view=dispatch&dispatchId=${dispatch.id}`);
                      }}
                      title={isDirector ? (dispatch.status === 'terminated' ? '点击维护这条派单记录' : '点击查看这条派单台账') : undefined}
                    >
                      <div className="board-card-code">{project.projectCode}</div>
                      <div className="board-card-name">{project.projectName}</div>
                      {dispatch.status !== 'done' && isOverdue(project.deadline, currentTime) ? <Tag color="red">已超时</Tag> : null}
                      <div className="board-card-meta">
                        <div>
                          <Tag color="geekblue">{dispatch.deptName}</Tag>
                          项目负责人：<strong className="board-card-person">{dispatch.assignee}</strong>
                        </div>
                        <div>委托方：{project.clientName || '—'}</div>
                        <div>委托方联系人：{project.clientContact || '—'}</div>
                        <div>委托方联系电话：{project.clientPhone || '—'}</div>
                        <div>交付成果类型：<strong className="board-card-type">{project.projectType}</strong></div>
                        <div>派单人：<strong className="board-card-person">{dispatch.dispatcherName}</strong></div>
                        <div>派单时间：{formatDateTime(dispatch.dispatchedAt)}</div>
                        <div>要求完成：{formatDate(project.deadline)}</div>
                        <div className="board-card-deadline">剩余工期：{dispatch.status === 'done' && dispatch.actualCompletionDate ? <span className={deadlineRemaining(project.deadline, dayjs(dispatch.actualCompletionDate)).urgent ? 'board-card-deadline-urgent' : ''}>{deadlineRemaining(project.deadline, dayjs(dispatch.actualCompletionDate)).label}</span> : <span className={deadlineRemaining(project.deadline, currentTime).urgent ? 'board-card-deadline-urgent' : ''}>{deadlineRemaining(project.deadline, currentTime).label}</span>}</div>
                        <div>预估收费：<strong className="board-card-fee">{formatFee(project.estimatedFee)}</strong></div>
                        <div>实际完成时间：{formatDate(dispatch.actualCompletionDate)}</div>
                        {dispatch.remark ? <div>备注：{dispatch.remark}</div> : null}
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <Space size={4}>
                          {isDirector ? (
                            <Button size="small" onClick={(e) => { e.stopPropagation(); setEditing(dispatch); }}>
                              更新
                            </Button>
                          ) : null}
                          {isDirector && dispatch.status !== 'terminated' ? (
                            <Button size="small" danger onClick={(e) => { e.stopPropagation(); revoke(dispatch); }}>
                              撤销派单
                            </Button>
                          ) : null}
                        </Space>
                      </div>
                    </div>
                  ))}
                  {revokedWithoutDispatch.map((project) => (
                    <div key={`project-${project.id}`} className="board-card board-card-revoked">
                      <div className="board-card-code">{project.projectCode}</div>
                      <div className="board-card-name">{project.projectName}</div>
                      <div className="board-card-meta">
                        <div>尚未派单的项目已撤销</div>
                        <div>委托方联系人：{project.clientContact || '—'}</div>
                        <div>委托方联系电话：{project.clientPhone || '—'}</div>
                      </div>
                    </div>
                  ))}
                  </>
                )}
                </BoardCardList>
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        className="section-card assignee-ranking"
        size="small"
        title="项目负责人派单排名"
        extra={<span className="section-hint">按有效派单次数统计，不含已撤销；同名合并</span>}
        loading={loading}
      >
        {error ? (
          <Alert type="error" showIcon message="负责人排名数据加载失败" description={error} />
        ) : assigneeRanking.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无负责人派单记录" />
        ) : (
          <div className="assignee-ranking-scroll" role="region" aria-label="项目负责人派单排名，可上下滚动" tabIndex={0}>
            <ol className="assignee-ranking-list">
              {assigneeRanking.map(({ name, count }) => {
                const rank = assigneeRanking.findIndex((item) => item.count === count) + 1;
                return (
                  <li className="assignee-ranking-row" key={name}>
                    <span className={`assignee-rank${rank <= 3 ? ' assignee-rank-leading' : ''}`}>{rank}</span>
                    <div className="assignee-ranking-info">
                      <div className="assignee-ranking-heading">
                        <strong>{name}</strong>
                        <span><strong>{count}</strong> 次</span>
                      </div>
                      <div className="assignee-ranking-track" aria-hidden="true">
                        <div className="assignee-ranking-fill" style={{ width: `${(count / maxAssigneeCount) * 100}%` }} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </Card>

      <Card size="small" title="各平台派单情况" className="section-card">
        <Table<DeptStat>
          rowKey="deptId"
          size="small"
          pagination={false}
          scroll={{ x: 500 }}
          dataSource={stats?.byDept ?? []}
          columns={[
            { title: '平台', dataIndex: 'deptName' },
            { title: '本月派单量', dataIndex: 'monthDispatched', width: 140 },
            { title: '已派单', dataIndex: 'dispatched', width: 120 },
            { title: '已完成', dataIndex: 'done', width: 120 },
          ]}
        />
      </Card>

      <UpdateDispatchModal
        open={Boolean(editing)}
        dispatch={editing}
        onClose={() => setEditing(null)}
        onDone={() => void reload(true)}
      />
    </div>
  );
}
