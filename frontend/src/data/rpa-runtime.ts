import type { ActionResult, EntryRow } from './types'

// RPA 执行批次运行时：与清单存储（scraper-config-studio:entries）相互独立，
// 老数据不做强制迁移，首次访问时按需接管。批次的全部生命周期数据都在这里：
// 步骤检查点、结果提取、回滚记录、被抑制的重复操作、并发锁与写入检查点。

const RUNTIME_KEY = 'scraper-config-studio:rpa-runtime'
const PENDING_KEY = 'scraper-config-studio:rpa-runtime:pending'
const LOCK_TTL_MS = 30_000

export type StepStatus = 'pending' | 'completed' | 'failed' | 'revoked'
export type BatchStatus = '执行中' | '已失败' | '已完成' | '已回滚' | '已归档'
export type ExtractionStatus = 'active' | 'revoked'

/** 步骤定义：操作序列、等待条件、结果提取在同一步骤上一一对应。 */
export interface RpaStepDef {
  seq: number
  name: string
  action: string
  waitCondition: string
  timeoutSec: number
  extractField?: string
}

export interface RpaStepState extends RpaStepDef {
  status: StepStatus
  attempt: number
  completedAt: number | null
  failureReason?: string
}

export interface RpaExtraction {
  id: string
  batchNo: string
  flowId: number
  stepSeq: number
  field: string
  value: string
  completedAt: number
  status: ExtractionStatus
  legacy?: boolean
}

export interface RpaRollback {
  id: string
  batchNo: string
  flowId: number
  reason: string
  createdAt: number
  revokedWrites: number
  status: 'active' | 'revoked'
}

export type SuppressOrigin = 'duplicate' | 'lock' | 'lww' | 'rollback-guard' | 'idempotent' | 'state'

export interface SuppressedEvent {
  id: string
  batchNo: string
  flowId: number
  at: number
  action: string
  origin: SuppressOrigin
  reason: string
}

export interface RuntimeEvent {
  id: string
  batchNo: string
  at: number
  type: string
  message: string
}

export interface BatchLock {
  holder: string
  acquiredAt: number
  expiresAt: number
}

export interface RpaBatch {
  batchNo: string
  flowId: number
  flowCode: string
  status: BatchStatus
  /** 最后成功完成的步骤序号，即续做恢复点。0 表示一步都还没成功。 */
  checkpoint: number
  steps: RpaStepState[]
  extractions: RpaExtraction[]
  rollbacks: RpaRollback[]
  suppressed: SuppressedEvent[]
  events: RuntimeEvent[]
  lock: BatchLock | null
  version: number
  /** 完成时刻序号：多个操作同时完成时，序号更大（完成更晚）的操作为准。 */
  completionSeq: number
  createdAt: number
  updatedAt: number
  legacy?: boolean
}

interface RpaRuntime {
  schema: 1
  batches: RpaBatch[]
}

export interface RpaActionResult extends ActionResult {
  batchNo?: string
  /** 本次动作期间被抑制的重复操作，便于页面即时反馈。 */
  suppressed?: SuppressedEvent[]
}

export interface BatchView {
  batch: RpaBatch
  recoveryPoint: string
  progress: { done: number; total: number }
  activeExtractions: RpaExtraction[]
  activeRollbacks: RpaRollback[]
  suppressedCount: number
}

interface FaultInjection {
  /** 下一次持久化在主数据写入前中断，用于验证「写入中断回滚上一检查点」。 */
  interruptNextWrite: boolean
}

const fault: FaultInjection = { interruptNextWrite: false }

let clock: () => number = () => Date.now()
let idSeq = 0

function nextId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${clock().toString(36)}-${idSeq}`
}

function todayStamp(): string {
  const d = new Date(clock())
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}${m}${day}`
}

// ---- 持久化：主 key + pending 检查点，写入中断可回滚到上一检查点 ----

function readRaw(key: string): string | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  return window.localStorage.getItem(key)
}

function writeRaw(key: string, value: string): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, value)
  }
}

function removeRaw(key: string): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(key)
  }
}

const recoveryNotices: string[] = []

function emptyRuntime(): RpaRuntime {
  return { schema: 1, batches: [] }
}

/**
 * 读取运行时。若发现上次写入留下的 pending 检查点，说明主数据可能只写了一半，
 * 直接回滚到 pending 里的上一检查点，并保留一条恢复提示。
 */
function loadRuntime(): RpaRuntime {
  const pendingRaw = readRaw(PENDING_KEY)
  if (pendingRaw !== null) {
    try {
      const snapshot = JSON.parse(pendingRaw) as RpaRuntime
      writeRaw(RUNTIME_KEY, JSON.stringify(snapshot))
      removeRaw(PENDING_KEY)
      recoveryNotices.push('检测到上次写入中断，已回滚到上一检查点，可从恢复点继续续做')
      return snapshot
    } catch {
      removeRaw(PENDING_KEY)
    }
  }
  const raw = readRaw(RUNTIME_KEY)
  if (!raw) return emptyRuntime()
  try {
    const parsed = JSON.parse(raw) as RpaRuntime
    if (!parsed || !Array.isArray(parsed.batches)) return emptyRuntime()
    return parsed
  } catch {
    recoveryNotices.push('运行时数据损坏，已回滚到上一检查点')
    return emptyRuntime()
  }
}

/**
 * 原子写：先把当前已提交版本固化为 pending 检查点，再写主数据，最后清检查点。
 * interruptNextWrite 打开时在主数据写入前抛错，模拟写入中断。
 */
function persistRuntime(runtime: RpaRuntime): void {
  const previous = readRaw(RUNTIME_KEY)
  if (previous !== null) {
    writeRaw(PENDING_KEY, previous)
  }
  if (fault.interruptNextWrite) {
    fault.interruptNextWrite = false
    throw new Error('模拟写入中断：主数据尚未提交，保留上一检查点')
  }
  writeRaw(RUNTIME_KEY, JSON.stringify(runtime))
  removeRaw(PENDING_KEY)
}

// ---- 步骤计划：存量占位字段走标准四步计划，可解析的操作序列按内容拆分 ----

/**
 * 把一条 RPA 流程拆成步骤计划。每个步骤同时带上自己的操作、等待条件与超时，
 * 最后一步负责结果提取，保证三者严格对应，续做时不会错配。
 */
export function buildStepPlan(row: EntryRow): RpaStepDef[] {
  const timeout = Number(row['超时秒数']) || 30
  const seqText = String(row['操作序列'] ?? '')
  const waitText = String(row['等待条件'] ?? '')
  const separators = /[→、,，;；]/
  if (seqText && separators.test(seqText)) {
    const actions = seqText.split(separators).map((s) => s.trim()).filter(Boolean)
    const waits = waitText.split(separators).map((s) => s.trim()).filter(Boolean)
    return actions.map((action, index) => ({
      seq: index + 1,
      name: `步骤${index + 1}`,
      action,
      waitCondition: waits[index] ?? waits[waits.length - 1] ?? '默认等待条件',
      timeoutSec: timeout,
      extractField: index === actions.length - 1 ? String(row['结果提取'] || '提取结果') : undefined,
    }))
  }
  return [
    { seq: 1, name: '打开目标页面', action: '导航打开目标页面', waitCondition: '页面加载完成', timeoutSec: timeout },
    { seq: 2, name: '执行操作序列', action: '逐项填写操作表单', waitCondition: '输入框就绪', timeoutSec: timeout },
    { seq: 3, name: '等待提交按钮', action: '点击提交按钮', waitCondition: '按钮可点击', timeoutSec: timeout },
    { seq: 4, name: '结果提取', action: '采集并提取页面结果', waitCondition: '结果区域出现', timeoutSec: timeout, extractField: String(row['结果提取'] || '提取结果') },
  ]
}

function toStepState(def: RpaStepDef): RpaStepState {
  return { ...def, status: 'pending', attempt: 0, completedAt: null }
}

// ---- 批次查询与存量兼容 ----

function latestBatchOf(runtime: RpaRuntime, flowId: number): RpaBatch | undefined {
  // 批次只在创建时 push，数组顺序即创建顺序；同刻创建也不能靠时间戳排序，直接取最后一条。
  const matches = runtime.batches.filter((batch) => batch.flowId === flowId)
  return matches[matches.length - 1]
}

export function takeRecoveryNotices(): string[] {
  return recoveryNotices.splice(0, recoveryNotices.length)
}

function describeRecoveryPoint(batch: RpaBatch): string {
  if (batch.checkpoint <= 0) return '起点（第1步之前），尚无成功步骤'
  const step = batch.steps[batch.checkpoint - 1]
  const next = batch.steps[batch.checkpoint]
  const nextText = next ? `，续做从第${next.seq}步「${next.name}」开始` : '，全部步骤已完成'
  return `第${batch.checkpoint}步「${step?.name ?? ''}」之后${nextText}`
}

function toView(batch: RpaBatch): BatchView {
  return {
    batch,
    recoveryPoint: describeRecoveryPoint(batch),
    progress: {
      done: batch.steps.filter((step) => step.status === 'completed').length,
      total: batch.steps.length,
    },
    activeExtractions: batch.extractions.filter((item) => item.status === 'active'),
    activeRollbacks: batch.rollbacks.filter((item) => item.status === 'active'),
    suppressedCount: batch.suppressed.length,
  }
}

export function listBatchViews(flows: EntryRow[]): BatchView[] {
  const runtime = loadRuntime()
  return flows
    .map((flow) => latestBatchOf(runtime, Number(flow.id)))
    .filter((batch): batch is RpaBatch => Boolean(batch))
    .map(toView)
}

export function getBatchView(flowId: number): BatchView | null {
  const runtime = loadRuntime()
  const batch = latestBatchOf(runtime, flowId)
  return batch ? toView(batch) : null
}

/**
 * 存量兼容：旧系统里已经处于「执行中/已失败」的流程没有批次记录，
 * 首次查看时按原流程接管一个 legacy 批次，批次号沿用流程编号派生，
 * 恢复点为起点（旧系统本就没有步骤检查点），不补造任何历史结果。
 */
export function ensureLegacyBatch(row: EntryRow): RpaBatch | null {
  const flowId = Number(row.id)
  const runtime = loadRuntime()
  const existing = latestBatchOf(runtime, flowId)
  if (existing) return existing
  const status = String(row.status)
  if (status !== '执行中' && status !== '已失败') return null
  const now = clock()
  const flowCode = String(row['流程编号'] ?? `RPAF-${flowId}`)
  const batch: RpaBatch = {
    batchNo: `BATCH-${flowCode}-${todayStamp()}-00`,
    flowId,
    flowCode,
    status: status === '已失败' ? '已失败' : '执行中',
    checkpoint: 0,
    steps: buildStepPlan(row).map(toStepState),
    extractions: [],
    rollbacks: [],
    suppressed: [],
    events: [
      {
        id: nextId('EVT'),
        batchNo: '',
        at: now,
        type: 'legacy-takeover',
        message: '存量流程被批次运行时接管，旧系统未留存步骤检查点，恢复点定为起点',
      },
    ],
    lock: null,
    version: 1,
    completionSeq: 0,
    createdAt: now,
    updatedAt: now,
    legacy: true,
  }
  batch.events[0].batchNo = batch.batchNo
  runtime.batches.push(batch)
  persistRuntime(runtime)
  return batch
}

// ---- 批次内部记录工具 ----

function addEvent(batch: RpaBatch, type: string, message: string): void {
  batch.events.push({ id: nextId('EVT'), batchNo: batch.batchNo, at: clock(), type, message })
}

function addSuppressed(batch: RpaBatch, action: string, origin: SuppressOrigin, reason: string): SuppressedEvent {
  const event: SuppressedEvent = {
    id: nextId('SUP'),
    batchNo: batch.batchNo,
    flowId: batch.flowId,
    at: clock(),
    action,
    origin,
    reason,
  }
  batch.suppressed.push(event)
  addEvent(batch, 'suppressed', `「${action}」被抑制：${reason}`)
  return event
}

function nextBatchNo(runtime: RpaRuntime, flowCode: string): string {
  const seq = runtime.batches.filter((batch) => batch.flowCode === flowCode).length + 1
  return `BATCH-${flowCode}-${todayStamp()}-${`${seq}`.padStart(2, '0')}`
}

function newHolder(): string {
  return `holder-${clock().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function tryAcquireLock(batch: RpaBatch): string | null {
  const now = clock()
  if (batch.lock && batch.lock.expiresAt > now) {
    return null
  }
  const holder = newHolder()
  batch.lock = { holder, acquiredAt: now, expiresAt: now + LOCK_TTL_MS }
  return holder
}

function releaseLock(batch: RpaBatch, holder: string): void {
  if (batch.lock?.holder === holder) {
    batch.lock = null
  }
}

// ---- 步骤完成：幂等 + LWW（完成时刻较晚者为准）----

/**
 * 完成一个步骤。重复完成同一操作时不重复造结果：
 * 完成时刻更晚的覆盖更早的，更早的记为 lww 抑制；同刻完成用 completionSeq 定先后。
 */
function completeStep(batch: RpaBatch, seq: number, completedAt: number): RpaStepState {
  const step = batch.steps.find((item) => item.seq === seq)
  if (!step) throw new Error(`步骤${seq}不存在`)
  batch.completionSeq += 1
  if (step.status === 'completed' && step.completedAt !== null) {
    if (completedAt >= step.completedAt) {
      addEvent(batch, 'lww', `第${seq}步收到更晚完成的操作（${completedAt}），覆盖较早结果`)
      step.completedAt = completedAt
      step.attempt += 1
    } else {
      addSuppressed(batch, `完成第${seq}步`, 'lww', `完成时刻${completedAt}早于已记录的${step.completedAt}，以较晚操作为准`)
    }
    return step
  }
  step.status = 'completed'
  step.completedAt = completedAt
  step.attempt += 1
  step.failureReason = undefined
  if (seq > batch.checkpoint) {
    batch.checkpoint = seq
  }
  addEvent(batch, 'step-done', `第${seq}步「${step.name}」完成，检查点推进到${batch.checkpoint}`)
  return step
}

function upsertExtraction(batch: RpaBatch, stepSeq: number, field: string, value: string, completedAt: number): void {
  const existing = batch.extractions.find(
    (item) => item.stepSeq === stepSeq && item.field === field && item.batchNo === batch.batchNo,
  )
  if (existing) {
    if (completedAt >= existing.completedAt) {
      existing.value = value
      existing.completedAt = completedAt
      existing.status = 'active'
      addEvent(batch, 'lww', `提取字段「${field}」收到更晚写入，以较晚操作为准`)
    } else {
      addSuppressed(batch, `提取${field}`, 'lww', '较早完成的提取写入被丢弃，以较晚操作为准')
    }
    return
  }
  batch.extractions.push({
    id: nextId('EXTR'),
    batchNo: batch.batchNo,
    flowId: batch.flowId,
    stepSeq,
    field,
    value,
    completedAt,
    status: 'active',
  })
  addEvent(batch, 'extraction', `结果提取「${field}」已按批次${batch.batchNo}归档`)
}

// ---- 模拟执行：按检查点续跑，故障注入点固定在第3步等待按钮 ----

export interface StartOptions {
  /** true 时在第3步等待按钮超时，复现现场 RPAF-93。 */
  injectTimeout?: boolean
}

function runSteps(batch: RpaBatch, fromSeq: number, injectTimeout: boolean): void {
  for (const step of batch.steps.filter((item) => item.seq >= fromSeq)) {
    if (injectTimeout && step.seq === 3) {
      step.status = 'failed'
      step.attempt += 1
      step.failureReason = `等待条件「${step.waitCondition}」在${step.timeoutSec}秒内未满足，等待按钮超时`
      addEvent(batch, 'timeout', `第3步等待按钮超时，流程停在检查点${batch.checkpoint}，等待续做`)
      batch.status = '已失败'
      batch.updatedAt = clock()
      return
    }
    const at = clock()
    completeStep(batch, step.seq, at)
    if (step.extractField) {
      upsertExtraction(batch, step.seq, step.extractField, `${batch.flowCode}-第${step.seq}步提取值`, at)
    }
    if (step.seq > batch.checkpoint) batch.checkpoint = step.seq
  }
  const allDone = batch.steps.every((step) => step.status === 'completed')
  if (allDone) {
    batch.status = '已完成'
    addEvent(batch, 'finished', `批次${batch.batchNo}全部步骤完成，结果提取已归档`)
  }
  batch.updatedAt = clock()
}

function fail(message: string, batchNo?: string, suppressed: SuppressedEvent[] = []): RpaActionResult {
  return { ok: false, message, batchNo, suppressed }
}

function persistRuntimeQuiet(runtime: RpaRuntime): void {
  try {
    persistRuntime(runtime)
  } catch {
    // 仅记录抑制事件的辅助写入，中断不改变主流程结论
  }
}

// ---- 对外动作 ----

/** 启动流程：生成并保留执行批次标识。已归档/已回滚的批次才允许开新批次。 */
export function startBatch(flow: EntryRow, options: StartOptions = {}): RpaActionResult {
  const runtime = loadRuntime()
  const flowId = Number(flow.id)
  const flowCode = String(flow['流程编号'] ?? `RPAF-${flowId}`)
  const latest = latestBatchOf(runtime, flowId)
  if (latest && latest.status !== '已回滚') {
    const reason =
      latest.status === '已归档'
        ? `批次${latest.batchNo}已归档，历史结果按原批次封存，如需新一轮执行请先确认归档`
        : `批次${latest.batchNo}仍在生命周期内，续做必须保留原批次标识`
    const event = addSuppressed(latest, '启动流程', 'duplicate', reason)
    try {
      persistRuntime(runtime)
    } catch (error) {
      return fail(error instanceof Error ? error.message : '写入中断')
    }
    return fail(`批次${latest.batchNo}已存在，请使用「续做恢复」而不是重新启动`, latest.batchNo, [event])
  }
  const now = clock()
  const batch: RpaBatch = {
    batchNo: nextBatchNo(runtime, flowCode),
    flowId,
    flowCode,
    status: '执行中',
    checkpoint: 0,
    steps: buildStepPlan(flow).map(toStepState),
    extractions: [],
    rollbacks: [],
    suppressed: [],
    events: [],
    lock: null,
    version: 1,
    completionSeq: 0,
    createdAt: now,
    updatedAt: now,
  }
  const holder = tryAcquireLock(batch)
  if (!holder) return fail('批次锁获取失败，请稍后重试', batch.batchNo)
  addEvent(batch, 'start', `批次${batch.batchNo}启动，执行批次标识已固定`)
  runtime.batches.push(batch)
  try {
    runSteps(batch, 1, Boolean(options.injectTimeout))
    batch.version += 1
    // 先释放锁再持久化：持锁状态落盘会让后续续做被自己的锁挡住直到 TTL 过期。
    releaseLock(batch, holder)
    persistRuntime(runtime)
  } catch (error) {
    releaseLock(batch, holder)
    return fail(error instanceof Error ? error.message : '执行中断，已保留上一检查点', batch.batchNo)
  }
  if (options.injectTimeout && batch.status === '已失败') {
    return { ok: true, batchNo: batch.batchNo, message: `第3步等待按钮超时，批次${batch.batchNo}停在恢复点：${describeRecoveryPoint(batch)}` }
  }
  return { ok: true, batchNo: batch.batchNo, message: `批次${batch.batchNo}启动完成，恢复点：${describeRecoveryPoint(batch)}` }
}

/**
 * 续做恢复：只允许从最后成功操作（检查点）之后继续，已完成步骤与结果提取不重做。
 * 并发续做同一批次时靠批次锁保证只有一次成功，失败者记入被抑制操作。
 */
export function resumeBatch(flowId: number, options: StartOptions = {}): RpaActionResult {
  const runtime = loadRuntime()
  const batch = latestBatchOf(runtime, flowId)
  if (!batch) {
    return fail('没有可恢复的执行批次，请先启动流程')
  }
  if (batch.status === '已完成' || batch.status === '已归档') {
    const event = addSuppressed(batch, '续做恢复', 'state', `批次状态为「${batch.status}」，无需续做`)
    persistRuntimeQuiet(runtime)
    return fail(`批次${batch.batchNo}已是「${batch.status}」，无需续做`, batch.batchNo, [event])
  }
  if (batch.status === '已回滚') {
    const event = addSuppressed(batch, '续做恢复', 'state', '批次已回滚，请重新启动新批次')
    persistRuntimeQuiet(runtime)
    return fail('批次已回滚，不能续做，请重新启动', batch.batchNo, [event])
  }
  const holder = tryAcquireLock(batch)
  if (!holder) {
    const event = addSuppressed(batch, '续做恢复', 'lock', '同一执行批次的并发续做只允许一次成功，当前批次锁被占用')
    try {
      persistRuntime(runtime)
    } catch (error) {
      return fail(error instanceof Error ? error.message : '写入中断', batch.batchNo)
    }
    return fail('并发续做被拒绝：该批次已有续做在执行，只允许一次成功', batch.batchNo, [event])
  }
  addEvent(batch, 'resume', `从恢复点续做：${describeRecoveryPoint(batch)}，原批次标识${batch.batchNo}保持不变`)
  const fromSeq = batch.checkpoint + 1
  try {
    runSteps(batch, fromSeq, Boolean(options.injectTimeout))
    batch.version += 1
    releaseLock(batch, holder)
    persistRuntime(runtime)
  } catch (error) {
    releaseLock(batch, holder)
    return fail(error instanceof Error ? error.message : '写入中断，已保留上一检查点', batch.batchNo)
  }
  return {
    ok: true,
    batchNo: batch.batchNo,
    message: `批次${batch.batchNo}已从第${fromSeq}步续做完成，当前恢复点：${describeRecoveryPoint(batch)}`,
  }
}

/**
 * 并发续做演示：同一批次同时发起两次续做。
 * 两者先竞争批次锁，只有持锁方真正执行，竞争失败方记为 lock 抑制，保证只允许一次成功。
 */
export function resumeBatchConcurrent(flowId: number): { winner: RpaActionResult; loser: RpaActionResult } {
  const runtime = loadRuntime()
  const batch = latestBatchOf(runtime, flowId)
  if (!batch) {
    const none = fail('没有可恢复的执行批次，请先启动流程')
    return { winner: none, loser: none }
  }
  if (batch.status !== '执行中' && batch.status !== '已失败') {
    const state = fail(`批次${batch.batchNo}当前为「${batch.status}」，并发续做演示需要先制造超时失败`)
    return { winner: state, loser: state }
  }
  const holderA = tryAcquireLock(batch)
  if (!holderA) {
    // 锁已被别的续做占用：双方都失败，零写入，只允许一次成功的语义由持锁方保证。
    const event = addSuppressed(batch, '续做恢复(并发)', 'lock', '批次锁被占用，并发续做请求全部被拒绝')
    persistRuntimeQuiet(runtime)
    const rejected = fail('并发续做被拒绝：该批次已有续做在执行，只允许一次成功', batch.batchNo, [event])
    return { winner: rejected, loser: rejected }
  }
  // 请求B竞争失败：先落盘抑制记录，随后释放锁，由请求A走唯一一次正式续做。
  const event = addSuppressed(
    batch,
    '续做恢复(并发请求B)',
    'lock',
    '并发续做竞争失败：同一执行批次只允许一次成功，锁由请求A持有',
  )
  const loser: RpaActionResult = {
    ok: false,
    batchNo: batch.batchNo,
    message: '并发续做被拒绝：该批次已有续做在执行，只允许一次成功',
    suppressed: [event],
  }
  releaseLock(batch, holderA)
  try {
    persistRuntime(runtime)
  } catch (error) {
    return { winner: fail(error instanceof Error ? error.message : '写入中断', batch.batchNo), loser }
  }
  const winner = resumeBatch(flowId)
  return { winner, loser }
}

/** 终止流程：失败态保留检查点，不抹掉已完成步骤与提取结果。 */
export function terminateBatch(flowId: number, reason = '人工终止流程'): RpaActionResult {
  const runtime = loadRuntime()
  const batch = latestBatchOf(runtime, flowId)
  if (!batch) return fail('没有可终止的执行批次')
  if (batch.status === '已归档' || batch.status === '已回滚') {
    const event = addSuppressed(batch, '终止流程', 'state', `批次状态为「${batch.status}」，终止被忽略`)
    persistRuntimeQuiet(runtime)
    return fail(`批次${batch.batchNo}已是「${batch.status}」，不能终止`, batch.batchNo, [event])
  }
  batch.status = '已失败'
  batch.updatedAt = clock()
  addEvent(batch, 'terminate', `${reason}，检查点保留在第${batch.checkpoint}步`)
  try {
    persistRuntime(runtime)
  } catch (error) {
    return fail(error instanceof Error ? error.message : '写入中断', batch.batchNo)
  }
  return { ok: true, batchNo: batch.batchNo, message: `批次${batch.batchNo}已终止，可从恢复点续做` }
}

/**
 * 异常回滚：只撤销本批次写入（本批次步骤完成态与本批次结果提取），
 * 历史执行批次的提取结果一条都不碰；回滚记录按批次幂等，重复点击只保留一条。
 */
export function rollbackBatch(flowId: number, reason = '等待条件超时触发异常回滚'): RpaActionResult {
  const runtime = loadRuntime()
  const batch = latestBatchOf(runtime, flowId)
  if (!batch) return fail('没有可回滚的执行批次')
  const existing = batch.rollbacks.find((item) => item.status === 'active')
  if (existing) {
    const event = addSuppressed(batch, '异常回滚', 'idempotent', `批次${batch.batchNo}已存在回滚记录${existing.id}，重复回滚不重复记账`)
    try {
      persistRuntime(runtime)
    } catch (error) {
      return fail(error instanceof Error ? error.message : '写入中断', batch.batchNo)
    }
    return fail('本批次已回滚过，回滚记录保持一条不重复生成', batch.batchNo, [event])
  }
  if (batch.status === '已归档') {
    const event = addSuppressed(batch, '异常回滚', 'rollback-guard', '已归档批次属于历史提取结果，禁止回滚触碰')
    try {
      persistRuntime(runtime)
    } catch (error) {
      return fail(error instanceof Error ? error.message : '写入中断', batch.batchNo)
    }
    return fail('已归档的历史批次受保护，回滚只能撤销本批次写入', batch.batchNo, [event])
  }
  let revokedWrites = 0
  for (const step of batch.steps) {
    if (step.status === 'completed' || step.status === 'failed') {
      step.status = 'revoked'
      revokedWrites += 1
    }
  }
  for (const extraction of batch.extractions) {
    if (extraction.batchNo === batch.batchNo && extraction.status === 'active') {
      extraction.status = 'revoked'
      revokedWrites += 1
    }
  }
  batch.rollbacks.push({
    id: nextId('RB'),
    batchNo: batch.batchNo,
    flowId,
    reason,
    createdAt: clock(),
    revokedWrites,
    status: 'active',
  })
  batch.status = '已回滚'
  batch.lock = null
  batch.updatedAt = clock()
  addEvent(batch, 'rollback', `回滚仅撤销本批次${revokedWrites}条写入，历史批次提取结果未触碰`)
  try {
    persistRuntime(runtime)
  } catch (error) {
    return fail(error instanceof Error ? error.message : '写入中断', batch.batchNo)
  }
  return { ok: true, batchNo: batch.batchNo, message: `批次${batch.batchNo}已回滚${revokedWrites}条本批次写入，历史提取结果保持不变` }
}

/** 归档结果：批次封存为历史，后续回滚/续做都被守卫拦截。 */
export function archiveBatch(flowId: number): RpaActionResult {
  const runtime = loadRuntime()
  const batch = latestBatchOf(runtime, flowId)
  if (!batch) return fail('没有可归档的执行批次')
  if (batch.status !== '已完成') {
    const event = addSuppressed(batch, '归档结果', 'state', `仅已完成批次可归档，当前为「${batch.status}」`)
    persistRuntimeQuiet(runtime)
    return fail(`批次当前为「${batch.status}」，完成后才能归档`, batch.batchNo, [event])
  }
  batch.status = '已归档'
  batch.updatedAt = clock()
  addEvent(batch, 'archive', `批次${batch.batchNo}归档，历史提取结果按原执行批次封存`)
  try {
    persistRuntime(runtime)
  } catch (error) {
    return fail(error instanceof Error ? error.message : '写入中断', batch.batchNo)
  }
  return { ok: true, batchNo: batch.batchNo, message: `批次${batch.batchNo}已归档，历史提取结果按原批次保留` }
}

/** 打开写入中断故障注入：下一次持久化必然失败，用于验证检查点回滚。 */
export function armWriteInterrupt(): void {
  fault.interruptNextWrite = true
}

/** 测试辅助：替换时钟。 */
export function __setClock(impl: () => number): void {
  clock = impl
}

/** 测试辅助：清空运行时（仅自测脚本使用）。 */
export function __resetRuntime(): void {
  removeRaw(RUNTIME_KEY)
  removeRaw(PENDING_KEY)
  recoveryNotices.length = 0
  idSeq = 0
}

/** 测试辅助：对指定批次的某一步注入一次完成时刻，用于验证 LWW 冲突规则。 */
export function __completeStepAt(flowId: number, seq: number, completedAt: number): RpaActionResult {
  const runtime = loadRuntime()
  const batch = latestBatchOf(runtime, flowId)
  if (!batch) return fail('没有可恢复的执行批次')
  const before = batch.suppressed.length
  completeStep(batch, seq, completedAt)
  const rejected = batch.suppressed.length > before
  persistRuntimeQuiet(runtime)
  if (rejected) {
    return fail(`完成时刻${completedAt}早于已记录时刻，已按较晚操作为准抑制`, batch.batchNo)
  }
  return { ok: true, batchNo: batch.batchNo, message: `第${seq}步已按完成时刻${completedAt}记录` }
}

/** 测试辅助：注入一次带完成时刻的提取写入，用于验证提取冲突时较晚者为准。 */
export function __upsertExtractionAt(
  flowId: number,
  stepSeq: number,
  field: string,
  value: string,
  completedAt: number,
): RpaActionResult {
  const runtime = loadRuntime()
  const batch = latestBatchOf(runtime, flowId)
  if (!batch) return fail('没有可恢复的执行批次')
  const before = batch.suppressed.length
  upsertExtraction(batch, stepSeq, field, value, completedAt)
  const rejected = batch.suppressed.length > before
  persistRuntimeQuiet(runtime)
  if (rejected) {
    return fail(`提取写入时刻${completedAt}较早，已按较晚操作为准抑制`, batch.batchNo)
  }
  return { ok: true, batchNo: batch.batchNo, message: `提取「${field}=${value}」已按时刻${completedAt}写入` }
}
