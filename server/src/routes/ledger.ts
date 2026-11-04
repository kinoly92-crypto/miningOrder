import dayjs from 'dayjs';
import multer from 'multer';
import { Router } from 'express';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { writeAudit } from '../audit';
import { asyncRoute } from '../async-route';
import { createDispatchEntry } from '../dispatch-service';
import { ConflictError } from '../errors';
import { requireDirector, type AuthedRequest } from '../middleware';
import { findProjectByCode, listDepartments, loadProjects } from '../repo';
import { broadcastChange } from '../sse';
import type { BatchImportResult, BatchImportRowResult, DispatchStatus, Project, ProjectType, ProjectStatus } from '../../../shared/types';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  pending: '待派单',
  dispatched: '已派单',
  done: '已完成',
  terminated: '已撤销',
};

const DISPATCH_STATUS_LABELS: Record<DispatchStatus, string> = {
  dispatched: '已派单',
  done: '已完成',
  terminated: '已撤销',
};

const TEMPLATE_HEADERS = [
  '派单单号',
  '派单项目名称',
  '委托方',
  '委托方联系人',
  '委托方联系电话',
  '业务来源',
  '业务程度',
  '交付成果类型',
  '评估目的',
  '预估收费（元）',
  '要求完成时间',
  '主要承接平台',
  '项目负责人',
  '项目组成员',
  '签字评估师一',
  '签字评估师二',
  '备注',
] as const;

function text(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function numberValue(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function dateValue(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = dayjs(raw);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : null;
}

function workbookBuffer(workbook: XLSX.WorkBook): Buffer {
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function setDownloadHeaders(res: Response, filename: string): void {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
}

function buildExportWorkbook(projects: Project[]): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();

  const projectRows = projects.map((project) => ({
    派单单号: project.projectCode,
    派单项目名称: project.projectName,
    委托方: project.clientName ?? '',
    委托方联系人: project.clientContact ?? '',
    委托方联系电话: project.clientPhone ?? '',
    业务来源: project.businessSource ?? '',
    业务程度: project.businessLevel ?? '',
    交付成果类型: project.projectType,
    评估目的: project.evalPurpose ?? '',
    '预估收费（元）': project.estimatedFee ?? '',
    要求完成时间: project.deadline ?? '',
    项目状态: PROJECT_STATUS_LABELS[project.status],
    主要承接平台: project.dispatches.filter((d) => d.status !== 'terminated').map((d) => d.deptName).join('、'),
    项目负责人: project.dispatches.filter((d) => d.status !== 'terminated').map((d) => d.assignee).join('、'),
    项目组成员: project.dispatches.filter((d) => d.status !== 'terminated' && d.teamMembers).map((d) => d.teamMembers).join('；'),
    签字评估师一: project.dispatches.filter((d) => d.status !== 'terminated' && d.signatoryOne).map((d) => d.signatoryOne).join('；'),
    签字评估师二: project.dispatches.filter((d) => d.status !== 'terminated' && d.signatoryTwo).map((d) => d.signatoryTwo).join('；'),
    最近派单时间: project.dispatches[0]?.dispatchedAt ? dayjs(project.dispatches[0].dispatchedAt).format('YYYY-MM-DD HH:mm') : '',
    派单条数: project.dispatches.length,
  }));

  const dispatchRows = projects.flatMap((project) =>
    project.dispatches.map((dispatch) => ({
      派单单号: project.projectCode,
      派单项目名称: project.projectName,
      委托方: project.clientName ?? '',
      委托方联系人: project.clientContact ?? '',
      委托方联系电话: project.clientPhone ?? '',
      业务来源: project.businessSource ?? '',
      业务程度: project.businessLevel ?? '',
      交付成果类型: project.projectType,
      评估目的: project.evalPurpose ?? '',
      '预估收费（元）': project.estimatedFee ?? '',
      要求完成时间: project.deadline ?? '',
      主要承接平台: dispatch.deptName,
      项目负责人: dispatch.assignee,
      项目组成员: dispatch.teamMembers ?? '',
      签字评估师一: dispatch.signatoryOne ?? '',
      签字评估师二: dispatch.signatoryTwo ?? '',
      派单人: dispatch.dispatcherName,
      派单时间: dayjs(dispatch.dispatchedAt).format('YYYY-MM-DD HH:mm'),
      状态: DISPATCH_STATUS_LABELS[dispatch.status],
      备注: dispatch.remark ?? '',
    })),
  );

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(projectRows), '项目台账');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(dispatchRows), '派单记录');
  return workbook;
}

async function buildTemplateWorkbook(): Promise<XLSX.WorkBook> {
  const workbook = XLSX.utils.book_new();
  const departments = (await listDepartments()).map((item) => item.name).join('、');
  const templateRows = [
    {
      派单单号: '',
      派单项目名称: '示例：某某有限公司股东全部权益价值评估',
      委托方: '示例：某某有限公司',
      委托方联系人: '李先生',
      委托方联系电话: '13800000000',
      业务来源: '银行推荐',
      业务程度: 'A类',
      交付成果类型: '矿业权评估报告',
      评估目的: '股权交易',
      '预估收费（元）': 50000,
      要求完成时间: '2026-12-31',
      主要承接平台: '中和西南分公司',
      项目负责人: '张三',
      项目组成员: '王五；赵六',
      签字评估师一: '张三',
      签字评估师二: '李四',
      备注: '留空派单单号则自动生成',
    },
  ];
  const notesRows = [
    { 说明: '1. 第一张工作表必须保留当前表头，系统按列名识别。' },
    { 说明: '2. 必填列：派单项目名称、交付成果类型。待派单可同时留空主要承接平台和项目负责人；派单时两项均必填。' },
    { 说明: '3. 派单单号可留空；留空时系统自动生成，例如 PD2026--0001。' },
    { 说明: '4. 若填写已存在的派单单号，系统按“追加派单”处理，不会覆盖已有项目基础信息。' },
    { 说明: `5. 主要承接平台必须是：${departments}。旧模板“主要承接部门”“承接部门”列仍可使用。` },
    { 说明: '6. 交付成果类型必须是：矿业权出让收益报告、矿业权出让底价报告、矿业权评估报告、矿业权价款退还报告、咨询报告、其他。' },
    { 说明: '7. 要求完成时间建议使用 YYYY-MM-DD 格式。' },
    { 说明: '8. 评估目的必须是：破产清算、破产重整、了解价值、追溯评估、司法诉讼、司法执行、减值测试、债务重组、抵押融资、上市公司交易、股权交易、出让收益评估、出让收益底价评估、压覆补偿评估、起始价计算、价款（出让收益）退还、资产收购、其他。' },
    { 说明: '9. 项目组成员请用分号隔开；成员及签字评估师属于该行派单，待派单时请留空。' },
    { 说明: '10. 追加派单时，项目已有联系人、电话、业务来源和业务程度必须与填写值一致。' },
    { 说明: '11. 业务程度仅支持：A类、B类、C类。' },
  ];

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(templateRows, { header: [...TEMPLATE_HEADERS] }), '台账导入模板');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(notesRows), '导入说明');
  return workbook;
}

async function validateExistingProject(rowNumber: number, input: { code: string; name: string; type: ProjectType; clientName: string | null; clientContact: string | null; clientPhone: string | null; businessSource: string | null; businessLevel: string | null }): Promise<Project | undefined> {
  const existing = await findProjectByCode(input.code);
  if (!existing) return undefined;
  if (existing.projectName !== input.name) {
    throw new Error(`第 ${rowNumber} 行：派单单号 ${input.code} 已存在，但派单项目名称与现有台账不一致`);
  }
  if (existing.projectType !== input.type) {
    throw new Error(`第 ${rowNumber} 行：派单单号 ${input.code} 已存在，但交付成果类型与现有台账不一致`);
  }
  if (input.clientName && existing.clientName && existing.clientName !== input.clientName) {
    throw new Error(`第 ${rowNumber} 行：派单单号 ${input.code} 已存在，但委托方与现有台账不一致`);
  }
  if ((input.clientContact && input.clientContact !== existing.clientContact) ||
      (input.clientPhone && input.clientPhone !== existing.clientPhone)) {
    throw new Error(`第 ${rowNumber} 行：项目联系方式与现有台账不一致`);
  }
  if ((input.businessSource && input.businessSource !== existing.businessSource) ||
      (input.businessLevel && input.businessLevel !== existing.businessLevel)) {
    throw new Error(`第 ${rowNumber} 行：业务来源或业务程度与现有台账不一致`);
  }
  return existing;
}

router.get('/ledger/export', asyncRoute(async (req, res) => {
  const includeRevoked = req.query.includeRevoked !== 'false';
  const projects = await loadProjects();
  const exported = includeRevoked ? projects : projects
    .filter((project) => project.status !== 'terminated')
    .map((project) => ({ ...project, dispatches: project.dispatches.filter((d) => d.status !== 'terminated') }));
  const workbook = buildExportWorkbook(exported);
  setDownloadHeaders(res, `派单台账_${dayjs().format('YYYYMMDD_HHmmss')}.xlsx`);
  res.end(workbookBuffer(workbook));
}));

router.get('/ledger/import-template', asyncRoute(async (_req, res) => {
  const workbook = await buildTemplateWorkbook();
  setDownloadHeaders(res, '派单台账导入模板.xlsx');
  res.end(workbookBuffer(workbook));
}));

router.post('/ledger/import', requireDirector, upload.single('file'), asyncRoute(async (req: AuthedRequest, res) => {
  const user = req.user!;
  if (!req.file) {
    res.status(400).json({ success: false, error: '请先选择要导入的 Excel 文件' });
    return;
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', raw: false });
    const sheet = workbook.Sheets['台账导入模板'] ?? workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) {
      res.status(400).json({ success: false, error: '导入文件中未找到可识别的工作表' });
      return;
    }

    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' }).filter((row) =>
      Object.values(row).some((value) => text(value)),
    );
    if (rows.length === 0) {
      res.status(400).json({ success: false, error: '导入文件没有可用数据' });
      return;
    }

    const departments = await listDepartments();
    const resultRows: BatchImportRowResult[] = [];

    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2;
      try {
        const dispatchNo = text(row['派单单号']);
        const projectName = text(row['派单项目名称']);
        const clientName = text(row['委托方']);
        const clientContact = text(row['委托方联系人']);
        const clientPhone = text(row['委托方联系电话']);
        const businessSource = text(row['业务来源']);
        const businessLevelRaw = text(row['业务程度']);
        const businessLevel = businessLevelRaw && ['A类', 'B类', 'C类'].includes(businessLevelRaw) ? businessLevelRaw : null;
        if (businessLevelRaw && !businessLevel) {
          throw new Error(`第 ${rowNumber} 行：业务程度只能是 A类、B类 或 C类`);
        }
        const newType = text(row['交付成果类型']);
        const oldType = text(row['业务类型']);
        if (newType && oldType && newType !== oldType) {
          throw new Error(`第 ${rowNumber} 行：交付成果类型与旧业务类型列的值不一致`);
        }
        const projectType = (newType ?? oldType) as ProjectType | null;
        const evalPurpose = text(row['评估目的']);
        const estimatedFee = numberValue(row['预估收费（元）']);
        const deadline = dateValue(row['要求完成时间']);
        const deptName = text(row['主要承接平台']) ?? text(row['主要承接部门']) ?? text(row['承接部门']);
        const assignee = text(row['项目负责人']);
        const teamMembers = text(row['项目组成员']);
        const signatoryOne = text(row['签字评估师一']);
        const signatoryTwo = text(row['签字评估师二']);
        const remark = text(row['备注']);

        if (!projectName || !projectType || Boolean(deptName) !== Boolean(assignee)) {
          throw new Error(`第 ${rowNumber} 行：请填写项目名称和交付成果类型；主要承接平台与负责人必须同时填写或同时留空`);
        }
        if (!deptName && (teamMembers || signatoryOne || signatoryTwo)) {
          throw new Error(`第 ${rowNumber} 行：待派单项目不能填写派单成员或签字评估师，请在正式派单时填写`);
        }

        const dept = deptName ? departments.find((item) => item.name === deptName) : undefined;
        if (deptName && !dept) {
          throw new Error(`第 ${rowNumber} 行：主要承接平台“${deptName}”不存在`);
        }

        const existing = dispatchNo
          ? await validateExistingProject(rowNumber, { code: dispatchNo, name: projectName, type: projectType, clientName, clientContact, clientPhone, businessSource, businessLevel })
          : undefined;

        if (existing && !dept) throw new Error(`第 ${rowNumber} 行：已有项目追加派单时须填写主要承接平台和负责人`);
        const dispatch = dept && assignee ? { deptId: dept.id, assignee, teamMembers, signatoryOne, signatoryTwo, remark } : undefined;
        const project = await createDispatchEntry(
          existing
            ? {
                projectId: existing.id,
                dispatch,
              }
            : {
                project: {
                  projectCode: dispatchNo ?? undefined,
                  projectName,
                  clientName,
                  clientContact,
                  clientPhone,
                  businessSource,
                  businessLevel: businessLevel as Project['businessLevel'],
                  projectType,
                  evalPurpose,
                  estimatedFee,
                  deadline,
                },
                dispatch,
              },
          user,
        );

        resultRows.push({
          rowNumber,
          dispatchNo: project.projectCode,
          success: true,
          message: existing ? '已追加派单成功' : '已导入成功',
        });
      } catch (error) {
        const message =
          error instanceof ConflictError
            ? error.conflict.message
            : error instanceof Error
              ? error.message
              : `第 ${rowNumber} 行：导入失败`;
        resultRows.push({
          rowNumber,
          dispatchNo: text(row['派单单号']) ?? undefined,
          success: false,
          message,
        });
      }
    }

    const result: BatchImportResult = {
      total: resultRows.length,
      successCount: resultRows.filter((item) => item.success).length,
      failureCount: resultRows.filter((item) => !item.success).length,
      rows: resultRows,
    };

    await writeAudit({
      user,
      action: 'batch-import',
      targetType: 'ledger',
      detail: `批量导入台账，共 ${result.total} 行，成功 ${result.successCount} 行，失败 ${result.failureCount} 行`,
    });

    if (result.successCount > 0) {
      broadcastChange('dispatches');
    }

    res.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : '批量导入失败';
    res.status(400).json({ success: false, error: message });
  }
}));

export default router;
