<template>
  <section class="page" data-module="rpaflow">
    <header class="page-head">
      <div>
        <h2>RPA流程管理</h2>
        <p class="page-desc">维护RPA自动化流程的输入、执行约束与结果记录，执行批次支持检查点续做：超时后从最后成功操作继续，结果提取与回滚按批次隔离。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记自动化流程</button>
        <button class="btn" type="button" @click="exportRows">导出RPA流程清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-selected': selectedId === Number(row.id) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row['恢复点']" class="hint-text">（{{ row['恢复点'] }}）</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableActions()"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="selectRow(row)">批次详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无RPA流程数据，可先登记自动化流程</td>
        </tr>
      </tbody>
    </table>

    <section v-if="selected" class="batch-panel">
      <header class="panel-head">
        <div>
          <h3>执行批次详情 · {{ selected.batch.flowCode }} / {{ selected.batch.batchNo }}<span v-if="selected.batch.legacy" class="tag tag-warn">存量接管</span></h3>
          <p class="panel-desc">
            批次状态「{{ selected.batch.status }}」 · 进度 {{ selected.progress.done }}/{{ selected.progress.total }}
            · 恢复点：{{ selected.recoveryPoint }} · 版本 v{{ selected.batch.version }}
            · 被抑制重复操作 {{ selected.suppressedCount }} 条
          </p>
        </div>
        <div class="panel-tools">
          <label class="fault-toggle">
            <input v-model="injectTimeout" type="checkbox" />
            第3步等待按钮超时（复现RPAF-93）
          </label>
          <label class="fault-toggle">
            <input v-model="armInterrupt" type="checkbox" />
            下次写入中断（验证检查点回滚）
          </label>
          <button class="btn ghost" type="button" @click="closePanel">关闭面板</button>
        </div>
      </header>

      <h4 class="panel-sub">步骤检查点（操作序列 / 等待条件 / 结果提取一一对应）</h4>
      <table class="data-table sub-table">
        <thead>
          <tr>
            <th>步骤</th>
            <th>操作序列</th>
            <th>等待条件</th>
            <th>超时秒数</th>
            <th>结果提取字段</th>
            <th>状态</th>
            <th>尝试次数</th>
            <th>完成时刻</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="step in selected.batch.steps" :key="step.seq" :class="stepRowClass(step)">
            <td>第{{ step.seq }}步 {{ step.name }}</td>
            <td>{{ step.action }}</td>
            <td>{{ step.waitCondition }}</td>
            <td>{{ step.timeoutSec }}</td>
            <td>{{ step.extractField ?? '—' }}</td>
            <td>
              <span class="tag" :class="stepTagClass(step.status)">{{ stepStatusLabel(step) }}</span>
            </td>
            <td>{{ step.attempt }}</td>
            <td>{{ formatTime(step.completedAt) }}</td>
          </tr>
        </tbody>
      </table>

      <div class="panel-grid">
        <div>
          <h4 class="panel-sub">结果提取（按原执行批次保留）</h4>
          <table class="data-table sub-table">
            <thead>
              <tr><th>步骤</th><th>字段</th><th>值</th><th>完成时刻</th><th>状态</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in selected.batch.extractions" :key="item.id">
                <td>第{{ item.stepSeq }}步</td>
                <td>{{ item.field }}</td>
                <td>{{ item.value }}</td>
                <td>{{ formatTime(item.completedAt) }}</td>
                <td><span class="tag" :class="item.status === 'active' ? 'tag-ok' : 'tag-muted'">{{ item.status === 'active' ? '有效' : '已撤销' }}</span></td>
              </tr>
              <tr v-if="!selected.batch.extractions.length">
                <td colspan="5" class="empty-state">本批次暂无结果提取</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <h4 class="panel-sub">异常回滚（仅撤销本批次写入）</h4>
          <table class="data-table sub-table">
            <thead>
              <tr><th>回滚编号</th><th>原因</th><th>撤销写入数</th><th>时刻</th><th>状态</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in selected.batch.rollbacks" :key="item.id">
                <td>{{ item.id }}</td>
                <td>{{ item.reason }}</td>
                <td>{{ item.revokedWrites }}</td>
                <td>{{ formatTime(item.createdAt) }}</td>
                <td><span class="tag" :class="item.status === 'active' ? 'tag-warn' : 'tag-muted'">{{ item.status === 'active' ? '生效中' : '已失效' }}</span></td>
              </tr>
              <tr v-if="!selected.batch.rollbacks.length">
                <td colspan="5" class="empty-state">本批次暂无回滚记录，重复回滚会被幂等抑制</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <h4 class="panel-sub">被抑制的重复操作（采集批次清单同步可见）</h4>
      <table class="data-table sub-table">
        <thead>
          <tr><th>时刻</th><th>动作</th><th>抑制原因</th><th>来源</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in selected.batch.suppressed" :key="item.id">
            <td>{{ formatTime(item.at) }}</td>
            <td>{{ item.action }}</td>
            <td>{{ item.reason }}</td>
            <td><span class="tag tag-warn">{{ originLabel(item.origin) }}</span></td>
          </tr>
          <tr v-if="!selected.batch.suppressed.length">
            <td colspan="4" class="empty-state">暂无被抑制的操作</td>
          </tr>
        </tbody>
      </table>

      <h4 class="panel-sub">批次事件轨迹</h4>
      <ul class="event-list">
        <li v-for="event in [...selected.batch.events].reverse()" :key="event.id">
          <span class="event-time">{{ formatTime(event.at) }}</span>
          <span class="tag tag-muted">{{ event.type }}</span>
          <span>{{ event.message }}</span>
        </li>
      </ul>

      <footer class="panel-actions">
        <button class="btn primary" type="button" :disabled="!canResume" @click="doResume">从恢复点续做（保留原批次标识）</button>
        <button class="btn" type="button" @click="doConcurrentResume">并发续做演示（只允许一次成功）</button>
        <button class="btn" type="button" @click="doRollback">异常回滚（只撤销本批次）</button>
        <span v-if="panelMessage" class="panel-message" :class="panelOk ? 'ok-text' : 'error-text'">{{ panelMessage }}</span>
      </footer>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条RPA流程记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  armWriteInterrupt,
  listBatchViews,
  resumeBatchConcurrent,
  takeRecoveryNotices,
  type BatchView,
  type RpaStepState,
  type SuppressOrigin,
} from '@/data/rpa-runtime'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('rpaflow')
const columns = ['流程编号', '目标页面', '操作序列', '等待条件', '超时秒数', '结果提取', '异常回滚', '执行批次']
const statuses = ['草稿', '待校验', '执行中', '已完成', '已失败']
const stats = [{ label: '自动化流程总数', value: 0 }, { label: '执行中流程', value: 0 }, { label: '已完成流程', value: 0 }]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const panelMessage = ref('')
const panelOk = ref(true)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedId = ref<number | null>(null)
const selectedView = ref<BatchView | null>(null)
const injectTimeout = ref(false)
const armInterrupt = ref(false)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const selected = computed(() => selectedView.value)
const canResume = computed(() => {
  const batch = selectedView.value?.batch
  return Boolean(batch && (batch.status === '执行中' || batch.status === '已失败') && batch.checkpoint < batch.steps.length)
})

const rowActions = ['提交执行', '启动流程', '续做恢复', '终止流程', '异常回滚', '归档结果']

function availableActions(): string[] {
  return rowActions
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '自动化流程登记入口尚未接入审批流'
}

function showResult(ok: boolean, message: string) {
  panelOk.value = ok
  panelMessage.value = message
  if (!ok) {
    errorMessage.value = message
  }
  reload()
  refreshSelected()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  panelMessage.value = ''
  try {
    if (armInterrupt.value && (action === '启动流程' || action === '续做恢复')) {
      armWriteInterrupt()
      armInterrupt.value = false
    }
    const result = applyAction(meta.key, Number(row.id), action, { injectTimeout: injectTimeout.value })
    showResult(result.ok, result.message)
  } catch (error) {
    showResult(false, error instanceof Error ? error.message : 'RPA动作执行失败')
  }
}

function doResume() {
  if (selectedId.value === null || !canResume.value) return
  panelMessage.value = ''
  try {
    if (armInterrupt.value) {
      armWriteInterrupt()
      armInterrupt.value = false
    }
    const result = applyAction(meta.key, selectedId.value, '续做恢复', { injectTimeout: injectTimeout.value })
    showResult(result.ok, result.message)
  } catch (error) {
    showResult(false, error instanceof Error ? error.message : '续做失败')
  }
}

function doConcurrentResume() {
  if (selectedId.value === null) return
  panelMessage.value = '并发续做竞争中……'
  try {
    const { winner, loser } = resumeBatchConcurrent(selectedId.value)
    panelOk.value = true
    panelMessage.value = `并发续做：成功方「${winner.message}」；被抑制方「${loser.message}」`
    reload()
    refreshSelected()
  } catch (error) {
    showResult(false, error instanceof Error ? error.message : '并发续做演示失败')
  }
}

function doRollback() {
  if (selectedId.value === null) return
  const result = applyAction(meta.key, selectedId.value, '异常回滚')
  showResult(result.ok, result.message)
}

function selectRow(row: EntryRow) {
  selectedId.value = Number(row.id)
  refreshSelected()
}

function closePanel() {
  selectedId.value = null
  selectedView.value = null
}

function refreshSelected() {
  if (selectedId.value === null) {
    selectedView.value = null
    return
  }
  selectedView.value = listBatchViews(rows.value).find((view) => view.batch.flowId === selectedId.value) ?? null
}

function reload() {
  errorMessage.value = ''
  try {
    const notices = takeRecoveryNotices()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (notices.length > 0) {
      panelOk.value = true
      panelMessage.value = notices.join('；')
    }
    refreshSelected()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'RPA流程列表读取失败'
  }
}

function stepRowClass(step: RpaStepState): Record<string, boolean> {
  return {
    'step-done': step.status === 'completed',
    'step-failed': step.status === 'failed',
    'step-revoked': step.status === 'revoked',
  }
}

function stepTagClass(status: RpaStepState['status']): string {
  if (status === 'completed') return 'tag-ok'
  if (status === 'failed') return 'tag-warn'
  if (status === 'revoked') return 'tag-muted'
  return 'tag-info'
}

function stepStatusLabel(step: RpaStepState): string {
  const map: Record<RpaStepState['status'], string> = {
    pending: '待执行',
    completed: '已完成',
    failed: '失败',
    revoked: '已撤销',
  }
  return step.failureReason ? `${map[step.status]}：${step.failureReason}` : map[step.status]
}

function originLabel(origin: SuppressOrigin): string {
  const map: Record<SuppressOrigin, string> = {
    duplicate: '重复启动',
    lock: '并发锁',
    lww: '较晚完成优先',
    'rollback-guard': '回滚守卫',
    idempotent: '幂等抑制',
    state: '状态守卫',
  }
  return map[origin]
}

function formatTime(value: number | null): string {
  if (value === null) return '—'
  const d = new Date(value)
  const hh = `${d.getHours()}`.padStart(2, '0')
  const mm = `${d.getMinutes()}`.padStart(2, '0')
  const ss = `${d.getSeconds()}`.padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

onMounted(reload)
</script>
