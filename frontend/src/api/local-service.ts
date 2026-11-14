import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  archiveBatch,
  ensureLegacyBatch,
  getBatchView,
  resumeBatch,
  rollbackBatch,
  startBatch,
  terminateBatch,
  type RpaActionResult,
} from '@/data/rpa-runtime'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 批次状态回写到 RPA 流程清单：清单仍是流程主档，运行时负责批次续做。
const RPA_BATCH_STATUS: Record<string, string> = {
  执行中: '执行中',
  已失败: '已失败',
  已完成: '已完成',
  已回滚: '已失败',
  已归档: '已完成',
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  options: { injectTimeout?: boolean } = {},
): ActionResult {
  const meta = moduleMeta(key)
  if (key === 'rpaflow') {
    return runRpaAction(id, action, options)
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** RPA 动作入口：页面调用链不变，内部切换到执行批次运行时。 */
export function runRpaAction(id: number, action: string, options: { injectTimeout?: boolean } = {}): RpaActionResult {
  const rows = listRows('rpaflow')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的自动化流程` }
  }
  const flow = rows[index]
  // 存量兼容：旧系统遗留的执行中/已失败流程，首次操作时由运行时懒接管。
  const existing = ensureLegacyBatch(flow)
  let result: RpaActionResult
  switch (action) {
    case '启动流程':
      // 执行中/已失败的批次只能续做；已回滚或无批次时才允许启动新批次。
      result =
        existing && existing.status !== '已回滚'
          ? resumeBatch(id, { injectTimeout: options.injectTimeout })
          : startBatch(flow, { injectTimeout: options.injectTimeout })
      break
    case '续做恢复':
    case '恢复续做':
      result = resumeBatch(id, { injectTimeout: options.injectTimeout })
      break
    case '终止流程':
      result = terminateBatch(id)
      break
    case '异常回滚':
      result = rollbackBatch(id)
      break
    case '归档结果':
      result = archiveBatch(id)
      break
    case '提交执行':
      result = applyPlainRpaStatus(rows, index, '待校验')
      break
    default:
      return { ok: false, message: `自动化流程没有登记「${action}」这个动作` }
  }
  // 终止/归档/回滚等动作在运行时返回状态守卫失败时，也把提示带回页面，不抛异常。
  if (result.ok) {
    syncRpaRowStatus(id)
  }
  return result
}

function applyPlainRpaStatus(rows: EntryRow[], index: number, target: string): RpaActionResult {
  const updated: EntryRow = { ...rows[index], status: target, pending: true, abnormal: false }
  const next = [...rows]
  next[index] = updated
  saveRows('rpaflow', next)
  return { ok: true, message: `自动化流程已提交校验，当前状态「${target}」` }
}

/** 把最新批次状态、批次号、恢复点同步回流程清单行，重开页面也不会回到第一步。 */
export function syncRpaRowStatus(id: number): void {
  const view = getBatchView(id)
  if (!view) return
  const rows = listRows('rpaflow')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return
  const { batch, recoveryPoint } = view
  const status = RPA_BATCH_STATUS[batch.status] ?? rows[index].status
  const updated: EntryRow = {
    ...rows[index],
    status,
    pending: status === '执行中' || status === '已失败',
    abnormal: batch.status === '已回滚' || batch.status === '已失败',
    执行批次: batch.batchNo,
    恢复点: recoveryPoint,
    已抑制重复操作: batch.suppressed.length,
    本批次提取条数: batch.extractions.filter((item) => item.status === 'active').length,
    本批次回滚条数: batch.rollbacks.filter((item) => item.status === 'active').length,
  }
  const next = [...rows]
  next[index] = updated
  saveRows('rpaflow', next)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
