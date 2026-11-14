<template>
  <section class="page" data-module="spider">
    <header class="page-head">
      <div>
        <h2>采集任务管理</h2>
        <p class="page-desc">维护采集作业的输入、执行约束与结果记录，为采集任务提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记采集作业</button>
        <button class="btn" type="button" @click="exportRows">导出采集任务清单</button>
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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无采集任务数据，可先登记采集作业</td>
        </tr>
      </tbody>
    </table>

    <section class="batch-panel">
      <header class="panel-head">
        <div>
          <h3>采集批次清单（RPA执行批次恢复视图）</h3>
          <p class="panel-desc">
            与RPA流程共用同一批次运行时：恢复点、被抑制的重复操作、结果提取与回滚均按原执行批次同步展示，
            本页只读，不做任何写入。
          </p>
        </div>
        <div class="panel-tools">
          <button class="btn ghost" type="button" @click="reloadBatches">刷新批次视图</button>
        </div>
      </header>

      <table class="data-table sub-table">
        <thead>
          <tr>
            <th>执行批次</th>
            <th>关联流程</th>
            <th>批次状态</th>
            <th>本次恢复点</th>
            <th>步骤进度</th>
            <th>结果提取(有效)</th>
            <th>回滚记录</th>
            <th>被抑制重复操作</th>
            <th>更新时刻</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="view in batchViews" :key="view.batch.batchNo">
            <td>
              {{ view.batch.batchNo }}
              <span v-if="view.batch.legacy" class="tag tag-warn">存量接管</span>
            </td>
            <td>{{ view.batch.flowCode }}</td>
            <td><span class="tag" :class="batchTagClass(view.batch.status)">{{ view.batch.status }}</span></td>
            <td>{{ view.recoveryPoint }}</td>
            <td>{{ view.progress.done }}/{{ view.progress.total }}</td>
            <td>{{ view.activeExtractions.length }}</td>
            <td>{{ view.activeRollbacks.length }}</td>
            <td>
              <span class="tag" :class="view.suppressedCount > 0 ? 'tag-warn' : 'tag-muted'">{{ view.suppressedCount }}</span>
            </td>
            <td>{{ formatTime(view.batch.updatedAt) }}</td>
          </tr>
          <tr v-if="!batchViews.length">
            <td colspan="9" class="empty-state">暂无RPA执行批次，启动RPA流程后这里会显示恢复点与抑制记录</td>
          </tr>
        </tbody>
      </table>

      <h4 class="panel-sub">被抑制的重复操作明细</h4>
      <table class="data-table sub-table">
        <thead>
          <tr><th>执行批次</th><th>时刻</th><th>动作</th><th>抑制原因</th></tr>
        </thead>
        <tbody>
          <template v-for="view in batchViews" :key="view.batch.batchNo">
            <tr v-for="item in view.batch.suppressed" :key="item.id">
              <td>{{ view.batch.batchNo }}</td>
              <td>{{ formatTime(item.at) }}</td>
              <td>{{ item.action }}</td>
              <td>{{ item.reason }}</td>
            </tr>
          </template>
          <tr v-if="suppressedTotal === 0">
            <td colspan="4" class="empty-state">暂无被抑制的重复操作</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条采集任务记录</span>
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
import { listBatchViews, type BatchView } from '@/data/rpa-runtime'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('spider')
const columns = ['作业编号', '目标站点', '抽取模板', '起始地址', '并发线程数', '请求间隔秒', '每日上限条数', '超时秒数']
const actions = ['提交执行', '启动采集', '终止采集', '归档结果']
const statuses = ['草稿', '待执行', '运行中', '已完成', '已失败']
const stats = [{ label: '采集作业总数', value: 0 }, { label: '运行中作业', value: 0 }, { label: '已完成作业', value: 0 }]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const batchViews = ref<BatchView[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const suppressedTotal = computed(() => batchViews.value.reduce((sum, view) => sum + view.suppressedCount, 0))

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '采集作业登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reloadBatches() {
  // 采集批次清单直接读 RPA 批次运行时，保证恢复结果跨页面同步。
  batchViews.value = listBatchViews(rows.value.length ? rows.value : listEntries('rpaflow').items)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reloadBatches()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '采集任务列表读取失败'
  }
}

function batchTagClass(status: string): string {
  if (status === '已完成' || status === '已归档') return 'tag-ok'
  if (status === '已失败') return 'tag-warn'
  if (status === '已回滚') return 'tag-muted'
  return 'tag-info'
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
