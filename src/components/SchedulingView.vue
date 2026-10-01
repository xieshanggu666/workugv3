<script setup>
import { ref, computed, reactive } from 'vue'
import { useParkStore, newRequestId } from '@/store/park'

const store = useParkStore()

const tabs = [
  { k: 'dispatch', label: '动态调度' },
  { k: 'plan', label: '跨日计划' },
  { k: 'board', label: '排班看板' },
  { k: 'attendance', label: '考勤工时' },
  { k: 'requests', label: '调班加班' },
  { k: 'coverage', label: '岗位覆盖' }
]
const tab = ref('dispatch')

const today = computed(() => store.clock.day)
const days = computed(() => {
  const d = today.value
  return [d, d + 1, d + 2, d + 3]
})
const dayNames = d => d === today.value ? '今天' : d === today.value + 1 ? '明天' : `第${d}天`
const dayNames2 = d => dayNames(d)

// 按 日 × 员工 组织排班
const schedMap = computed(() => {
  const m = new Map()
  for (const s of store.schedules) {
    if (!m.has(s.day)) m.set(s.day, new Map())
    m.get(s.day).set(s.staff_id, s)
  }
  return m
})
const schedOf = (staffId, day) => schedMap.value.get(day)?.get(staffId)

const activeStaff = computed(() => store.staff.filter(s => s.active))
const nonSupervisor = computed(() => activeStaff.value.filter(s => s.role !== '运营主管'))

// 运营主管手动排班
const form = reactive({ staff_id: null, shift_id: null, day: null })
const formMsg = ref('')
function resetForm() { form.staff_id = null; form.shift_id = null; form.day = today.value }
resetForm()
async function submitSchedule() {
  if (!form.staff_id || !form.shift_id || !form.day) { formMsg.value = '请选择员工、班次与日期'; return }
  const r = await store.scheduleShift({
    staff_id: form.staff_id, shift_id: form.shift_id, day: form.day, request_id: newRequestId()
  })
  if (r?.ok) {
    formMsg.value = `排班成功 ${r.code || ''}${r.warnings?.length ? `，但有 ${r.warnings.length} 条岗位覆盖预警，请查看「岗位覆盖」` : ''}`
  } else formMsg.value = r?.msg ? `${r.msg}${r.code ? `〔${r.code}〕` : ''}` : '排班失败'
}
async function cancelS(s) {
  if (!confirm(`取消 ${s.staff_name} 第${s.day}天的「${s.shift_name}」排班？`)) return
  await store.cancelSchedule(s.id, newRequestId())
}

// 员工协作：调班 / 加班（行内表单）
const swaps = reactive({})   // scheduleId -> { target_staff_id, target_shift_id, target_day, reason }
const otForm = reactive({})   // scheduleId -> { ticks, reason }
function swapDraft(s) {
  if (!swaps[s.id]) swaps[s.id] = { target_staff_id: null, target_shift_id: s.shift_id, target_day: s.day, reason: '', open: false }
  return swaps[s.id]
}
function otDraft(s) {
  if (!otForm[s.id]) otForm[s.id] = { ticks: 1, reason: '', open: false }
  return otForm[s.id]
}
async function submitSwap(s) {
  const f = swaps[s.id]
  if (!f?.target_staff_id) return
  const r = await store.requestSwap(s.id, {
    staff_id: s.staff_id,
    target_staff_id: f.target_staff_id, target_shift_id: f.target_shift_id, target_day: f.target_day,
    reason: f.reason, request_id: newRequestId()
  })
  if (r?.ok) { f.open = false } else alert(r?.msg ? `${r.msg}〔${r.code || ''}〕` : '调班申请失败')
}
async function submitOt(s) {
  const f = otForm[s.id]
  const r = await store.requestOvertime(s.id, {
    staff_id: s.staff_id, ticks: f.ticks, reason: f.reason, request_id: newRequestId()
  })
  if (r?.ok) { f.open = false } else alert(r?.msg ? `${r.msg}〔${r.code || ''}〕` : '加班申请失败')
}
async function checkin(s) {
  const r = await store.checkinSchedule(s.id, newRequestId())
  if (!r?.ok) alert(r?.msg || '打卡失败')
}
async function leave(s) {
  const reason = prompt('登记离岗原因（当前考勤将按实际工时立即结算）：', '个人原因')
  if (reason === null) return
  const r = await store.leaveAttendance(s.attendance_id, reason, newRequestId())
  if (!r?.ok) alert(r?.msg || '离岗失败')
}

// ---- 考勤工时 ----
const attTab = ref('today')
const attendanceList = computed(() => {
  if (attTab.value === 'today') return store.attendance
  if (attTab.value === 'onduty') return store.attendance.filter(a => a.status === 'checked_in')
  if (attTab.value === 'absent') return store.attendance.filter(a => a.status === 'absent' || a.status === 'leave')
  return store.attendance
})
const statusMeta = st => ({
  checked_in: { label: '在岗', cls: 'st-on' },
  checked_out: { label: '已结算', cls: 'st-out' },
  absent: { label: '旷工', cls: 'st-absent' },
  leave: { label: '离岗', cls: 'st-leave' }
}[st] || { label: st, cls: '' })

// ---- 调班 / 加班申请 ----
const reqTab = ref('pending')
const requestList = computed(() => {
  if (reqTab.value === 'all') return store.shiftRequests
  return store.shiftRequests.filter(r => r.status === reqTab.value)
})
const reqStatusMeta = st => ({
  pending: { label: '待审批', cls: 'st-on' },
  approved: { label: '已批准', cls: 'st-out' },
  rejected: { label: '已驳回', cls: 'st-absent' },
  cancelled: { label: '已取消', cls: 'st-leave' }
}[st] || { label: st, cls: '' })

const approverId = computed(() => store.supervisors[0]?.id || null)
async function approve(r) { await store.approveShiftRequest(r.id, approverId.value) }
async function reject(r) {
  const note = prompt('驳回原因（可选）：', '')
  if (note === null) return
  await store.rejectShiftRequest(r.id, approverId.value, note)
}
async function withdraw(r) { await store.cancelShiftRequest(r.id, r.staff_id) }

// ---- 岗位覆盖（可按日查看） ----
const coverageDay = ref(today.value)
const coverageData = ref(null)
const coverage = computed(() => coverageData.value || store.coverageToday)
async function loadCoverage(d) {
  coverageDay.value = d
  coverageData.value = null
  const r = await store.coverageOf(d)
  if (r?.coverage) coverageData.value = r.coverage
}
const warnIcon = lv => lv === 'block' ? '⛔' : '⚠️'

// ---- 动态调度 ----
const plan = computed(() => store.dispatchPlanData)
const planDay = ref(today.value)
const planDayData = computed(() => plan.value.days?.find(x => x.day === planDay.value) || plan.value.days?.[0] || null)
const dispatchMsg = ref('')
const dispatching = ref(false)
const configForm = reactive({ mode: 'dynamic', guardFlow: 500, cleanFlow: 700, nightPerZone: 0, planApproval: 0 })
const autoFill = ref(true)
function syncConfigForm() {
  configForm.mode = plan.value.mode || 'dynamic'
  configForm.guardFlow = plan.value.params?.guardFlow ?? 500
  configForm.cleanFlow = plan.value.params?.cleanFlow ?? 700
  configForm.nightPerZone = plan.value.params?.nightGuardsPerZone ?? 0
  configForm.planApproval = plan.value.planApproval ? 1 : 0
  autoFill.value = plan.value.autoFill !== 0
}
// 配置数据到位后同步一次
if (plan.value.days?.length) syncConfigForm()
import { watch } from 'vue'
watch(() => [plan.value.mode, plan.value.params, plan.value.autoFill, plan.value.planApproval], syncConfigForm)

async function saveConfig() {
  const r = await store.saveScheduleConfig({
    mode: configForm.mode,
    guard_flow: Number(configForm.guardFlow),
    clean_flow: Number(configForm.cleanFlow),
    night_guards_per_zone: Number(configForm.nightPerZone)
  })
  dispatchMsg.value = r?.ok ? '调度参数已保存' : (r?.msg || '保存失败')
  setTimeout(() => { dispatchMsg.value = '' }, 2500)
}
async function togglePlanApproval(v) {
  configForm.planApproval = v ? 1 : 0
  const r = await store.saveScheduleConfig({ plan_approval: v ? 1 : 0 })
  dispatchMsg.value = r?.ok
    ? (v ? '已开启跨日计划审批：动态补位将先生成草案待主管批准' : '已关闭审批：动态补位直接落排班')
    : (r?.msg || '保存失败')
  if (v && store.pendingSchedulePlan) planTab.value = 'pending'
  setTimeout(() => { dispatchMsg.value = '' }, 3500)
}
async function toggleAutoFill(v) {
  autoFill.value = v
  await store.saveScheduleConfig({ auto_fill: v ? 1 : 0 })
}
async function runDispatch() {
  if (dispatching.value) return
  dispatching.value = true
  dispatchMsg.value = '动态调度执行中…'
  const r = await store.runDispatch({ reason: '主管手动触发动态调度', request_id: newRequestId() })
  dispatching.value = false
  if (r?.ok) {
    if (configForm.planApproval && r.plan) {
      dispatchMsg.value = `已生成跨日计划 ${r.plan.code}：补班 ${r.plan.pending_items ?? r.plan.item_count} 项、预计工资 ¥${r.plan.est_wage}，请前往「跨日计划」审批`
      planTab.value = 'pending'
    } else {
      dispatchMsg.value = `补位完成：新增排班 ${r.created?.length || 0} 张，紧急加班调令 ${r.otRequests?.length || 0} 张（待主管审批）`
    }
  } else dispatchMsg.value = r?.msg || '调度失败'
  setTimeout(() => { dispatchMsg.value = '' }, 4500)
}

// ---- 跨日排班计划 ----
const planTab = ref('pending')
const planHistory = ref([])
const planBusy = ref(false)
const planMsg = ref('')
const pendingPlan = computed(() => store.pendingSchedulePlan)
const planApprovalOn = computed(() => configForm.planApproval === 1 || stats.value.planApprovalMode === 1)

function flashPlan(msg, bad = false) {
  planMsg.value = (bad ? '✖ ' : '✔ ') + msg
  setTimeout(() => { planMsg.value = '' }, 4000)
}
async function loadHistory() {
  const r = await store.schedulePlans('all')
  planHistory.value = r?.list || []
}
function planDayName(d) { return dayNames(d) + `（第${d}天）` }
function itemsOfDay(day) {
  return (pendingPlan.value?.items || []).filter(i => i.day === day)
}
function groupOfDay(day) {
  return pendingPlan.value?.dayGroups?.find(g => g.day === day) || null
}
function refsText(it) {
  return (it.refs || []).map(r => r.code).join('、')
}
async function genPlan() {
  if (planBusy.value) return
  planBusy.value = true
  planMsg.value = '正在按最新预约客流 / 检修工单 / 投诉优先级测算跨日计划…'
  const r = await store.generateSchedulePlan({ horizon: 3, reason: '主管手动生成跨日计划', request_id: newRequestId() })
  planBusy.value = false
  if (r?.ok) flashPlan(`已生成 ${r.plan.code}：补班 ${r.schedule_count} 项、紧急调令 ${r.overtime_count} 项，预计新增工资 ¥${r.est_wage}`)
  else flashPlan(r?.msg ? `${r.msg}〔${r.code || ''}〕` : '生成失败', true)
  loadHistory()
}
async function approvePlan() {
  const p = pendingPlan.value
  if (!p) return
  if (!confirm(`批准 ${p.code} 并原子落地全部 ${p.pending_items} 项？\n（冲突/已过班段项会自动跳过；调令批准后按 1.5 倍时薪在下班结算）`)) return
  planBusy.value = true
  const r = await store.approveSchedulePlan(p.id, { approver_id: approverId.value, note: '主管批准跨日计划', request_id: newRequestId() })
  planBusy.value = false
  if (r?.ok) {
    flashPlan(`已批准：落地 ${r.applied} 项（跳过 ${r.skipped} 项），预计工资 ¥${r.est_wage}${r.followup?.generated ? '；残余缺口已生成补缺计划' : ''}`)
    planTab.value = 'pending'
  } else flashPlan(r?.msg ? `${r.msg}〔${r.code || ''}〕` : '批准失败', true)
  loadHistory()
}
async function rejectPlan() {
  const p = pendingPlan.value
  if (!p) return
  const note = prompt('驳回原因（可选；草案未落排班，无工资影响）：', '需求待重新评估')
  if (note === null) return
  planBusy.value = true
  const r = await store.rejectSchedulePlan(p.id, { approver_id: approverId.value, note, request_id: newRequestId() })
  planBusy.value = false
  flashPlan(r?.ok ? `已驳回 ${p.code}，无排班与工资影响` : (r?.msg || '驳回失败'), !r?.ok)
  loadHistory()
}
async function discardPlan() {
  const p = pendingPlan.value
  if (!p) return
  if (!confirm(`废弃 ${p.code}？（不会影响任何已排班次）`)) return
  const r = await store.cancelSchedulePlan(p.id, { note: '运营废弃', request_id: newRequestId() })
  flashPlan(r?.ok ? `已废弃 ${p.code}` : (r?.msg || '操作失败'), !r?.ok)
  loadHistory()
}
async function openPlanLogs(p) {
  const { logs } = await store.scheduleLogs({ planId: p.id })
  detailLogs.value = logs || []
  detailTitle.value = `${p.code} · 跨日计划时间线`
}
watch(tab, (v) => { if (v === 'plan') loadHistory() })
const PLAN_STATUS_META = {
  pending: { label: '待审批', cls: 'st-on' },
  approved: { label: '已批准', cls: 'st-out' },
  rejected: { label: '已驳回', cls: 'st-absent' },
  cancelled: { label: '已废弃', cls: 'st-leave' }
}
const BAND_META = {
  morning: { name: '早班', icon: '🌅', range: '09:00~12:00' },
  mid: { name: '中班', icon: '☀️', range: '12:00~14:00' },
  evening: { name: '晚班', icon: '🌇', range: '14:00~18:00' },
  night: { name: '夜班', icon: '🌙', range: '17:00~次日09:00' }
}
function bandRows(d) {
  return (d?.demand?.bands || []).map(b => {
    const ws = (d.warnings || []).filter(w => w.band === b.key)
    const blockN = ws.filter(w => w.level === 'block').length
    const warnN = ws.filter(w => w.level !== 'block').length
    const gapFor = role => {
      const w = ws.find(x => x.role === role)
      return w ? { gap: w.gap, level: w.level, need: w.need, have: w.have } : { gap: 0, level: '', need: 0, have: 0 }
    }
    return {
      ...b, blockN, warnN, orders: b.orders || [],
      gGuard: gapFor('保安/安保'), gClean: gapFor('保洁'), gRepair: gapFor('维修工')
    }
  })
}

// 排班状态徽标
function schedState(s) {
  if (!s) return { text: '休息', cls: 'off' }
  if (s.status === 'cancelled') return { text: '已取消', cls: 'cancelled' }
  if (s.status === 'swap') return { text: '调班中', cls: 'swap' }
  if (s.cross_day && s.night_phase) {
    return {
      upcoming: { text: '夜班待岗', cls: 'plan' },
      night_on: { text: '🌙当夜值守', cls: 'night' },
      morning_after: { text: '🌙凌晨值守', cls: 'night' },
      done: { text: '夜班已结', cls: 'done' }
    }[s.night_phase] || { text: '夜班', cls: 'night' }
  }
  if (s.att_status === 'checked_in') return { text: s.on_duty ? '在岗' : '考勤中', cls: 'on' }
  if (s.att_status === 'checked_out') return { text: '已下班', cls: 'done' }
  if (s.att_status === 'absent') return { text: '旷工', cls: 'absent' }
  if (s.att_status === 'leave') return { text: '离岗', cls: 'leave' }
  return { text: s.source === 'dispatch' ? '动态补位' : '已排班', cls: s.source === 'dispatch' ? 'dispatch' : 'plan' }
}
const SOURCE_LABEL = { manual: '手排', auto: '基础自动', dispatch: '动态补位', swap: '调班接替' }

// 时间线
const detailLogs = ref([])
const detailTitle = ref('')
async function openLogs(s) {
  let logs = []
  if (s.attendance_id) ({ logs } = await store.scheduleLogs({ attendanceId: s.attendance_id }))
  else ({ logs } = await store.scheduleLogs({ scheduleId: s.id }))
  detailLogs.value = logs || []
  detailTitle.value = `${s.staff_name} · 第${s.day}天 · ${s.shift_name}`
}
async function openReqLogs(r) {
  const { logs } = await store.scheduleLogs({ requestId: r.id })
  detailLogs.value = logs || []
  detailTitle.value = `${r.code} · ${r.staff_name}`
}
function closeLogs() { detailLogs.value = [] }
const ACTION_LABEL = {
  schedule: '排班', autofill: '基础自动排班', dispatch_fill: '动态补位', cancel: '取消排班',
  checkin: '打卡上班', late: '迟到', leave: '离岗', checkout: '下班结算', absent: '旷工',
  workdone: '完工回写',
  swap_request: '申请调班', swap_approve: '批准调班', swap_reject: '驳回调班',
  ot_request: '申请加班', ot_approve: '批准加班', ot_reject: '驳回加班',
  plan_create: '生成跨日计划', plan_approve: '批准跨日计划', plan_reject: '驳回跨日计划',
  plan_cancel: '废弃跨日计划', plan_stale: '计划需求变化', plan_item_apply: '计划补位落地'
}

const stats = computed(() => store.schedulingStats)
</script>

<template>
  <div class="sch">
    <div class="stat-grid">
      <div class="card stat"><span>🗓️</span><b>{{ stats.todayScheduled }}</b><em>今日排班</em></div>
      <div class="card stat"><span>👷</span><b class="on">{{ stats.onDuty }}</b><em>当前在岗</em></div>
      <div class="card stat"><span>🌙</span><b>{{ stats.nightOnDuty || 0 }}</b><em>夜班凌晨值守</em></div>
      <div class="card stat" :class="{ alert: stats.absentToday }"><span>❌</span><b :class="stats.absentToday ? 'neg' : ''">{{ stats.absentToday }}</b><em>今日旷工</em></div>
      <div class="card stat"><span>⏰</span><b>{{ stats.lateToday }}</b><em>今日迟到</em></div>
      <div class="card stat"><span>🚪</span><b>{{ stats.flowToday || 0 }}</b><em>预测客流(人)</em></div>
      <div class="card stat"><span>🤖</span><b>{{ stats.dispatchFilledToday || 0 }}</b><em>今日动态补位</em></div>
      <div class="card stat" :class="{ alert: stats.dispatchOtRequests }"><span>🆘</span><b>{{ stats.dispatchOtRequests || 0 }}</b><em>紧急调令待批</em></div>
      <div class="card stat"><span>🕑</span><b>{{ stats.overtimeHoursToday }}h</b><em>今日加班</em></div>
      <div class="card stat"><span>💰</span><b class="money neg">¥{{ (stats.payToday || 0).toLocaleString() }}</b><em>今日工时工资</em></div>
      <div class="card stat" :class="{ alert: stats.pendingRequests }"><span>📝</span><b>{{ stats.pendingRequests }}</b><em>待审批申请</em></div>
      <div class="card stat" :class="{ alert: stats.coverageWarnings }"><span>⚠️</span><b>{{ stats.coverageWarnings }}</b><em>覆盖预警</em></div>
    </div>

    <div class="tabs card-tabs">
      <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">
        {{ t.label }}
        <i v-if="t.k === 'requests' && stats.pendingRequests" class="badge-dot">{{ stats.pendingRequests }}</i>
        <i v-if="t.k === 'plan' && stats.pendingPlan" class="badge-dot" :class="{ 'stale-dot': stats.pendingPlanStale }">
          {{ stats.pendingPlanItems }}
        </i>
        <i v-if="t.k === 'dispatch' && stats.dispatchOtRequests" class="badge-dot alert-dot">{{ stats.dispatchOtRequests }}</i>
      </button>
      <label class="autofill" v-if="tab === 'board' || tab === 'dispatch'">
        <input type="checkbox" :checked="autoFill" @change="toggleAutoFill($event.target.checked)" />
        自动补位（引擎每小时巡检）
      </label>
    </div>

    <!-- ============ 动态调度 ============ -->
    <template v-if="tab === 'dispatch'">
      <div class="card dispatch-head">
        <div class="dh-row">
          <div class="dh-mode">
            <h3>🧠 动态调度引擎</h3>
            <p class="muted">
              融合 <b>分时预约客流</b>（入园 + 热门设施预约，未来日按散客均值外推）、<b>在途检修工单</b>、<b>待处置投诉岗位</b>
              三类需求，按早/中/晚/跨日夜班核算岗位缺口，自动智能补位；当天已开始班段的硬缺口转<b>紧急加班调令</b>走主管审批。
            </p>
          </div>
          <div class="dh-actions">
            <label class="mode-switch">
              调度模式
              <select v-model="configForm.mode" @change="saveConfig">
                <option value="dynamic">动态调度（按需求补缺口）</option>
                <option value="auto">基础补位（全员轮排日班）</option>
              </select>
            </label>
            <label class="mode-switch plan-switch">
              <input type="checkbox" :checked="configForm.planApproval === 1" @change="togglePlanApproval($event.target.checked)" />
              跨日计划审批（补位先出草案，主管批准后落地）
            </label>
            <button class="primary" :disabled="dispatching || !autoFill" @click="runDispatch">
              {{ dispatching ? '测算中…' : (configForm.planApproval ? '🧾 生成跨日补班计划' : '🚀 立即执行动态补位') }}
            </button>
          </div>
        </div>
        <div class="dh-params">
          <label>每名保安承载客流/班段（人）
            <input type="number" v-model.number="configForm.guardFlow" min="100" max="5000" step="50" @change="saveConfig" />
          </label>
          <label>每名保洁承载客流/班段（人）
            <input type="number" v-model.number="configForm.cleanFlow" min="100" max="5000" step="50" @change="saveConfig" />
          </label>
          <label>夜班保安区域配比（每 N 区 1 人，0=不强制）
            <input type="number" v-model.number="configForm.nightPerZone" min="0" max="10" @change="saveConfig" />
          </label>
          <em class="mmsg" :class="{ bad: dispatchMsg.includes('失败') }">{{ dispatchMsg }}</em>
        </div>
      </div>

      <div class="day-picker">
        <button v-for="d in days.slice(0,3)" :key="d" :class="{ on: planDay === d }" @click="planDay = d">
          {{ dayNames(d) }} · 第{{d}}天
        </button>
      </div>

      <div v-if="planDayData" class="card plan-card">
        <div class="plan-summary">
          <span>预测总客流 <b>{{ planDayData.demand.flowTotal }}</b> 人</span>
          <span>在途检修工单 <b :class="planDayData.demand.openOrders ? 'neg' : ''">{{ planDayData.demand.openOrders }}</b></span>
          <span>待处置投诉 <b :class="planDayData.demand.openComplaints ? 'neg' : ''">{{ planDayData.demand.openComplaints }}</b></span>
          <span>花名册 <b>{{ planDayData.rosterCount }}</b> 人</span>
          <span class="muted">开放区域 {{ planDayData.demand.zones.length }} 个</span>
        </div>

        <div class="band-grid">
          <div class="band-col" v-for="b in bandRows(planDayData)" :key="b.key" :class="{ blocked: b.blockN }">
            <div class="band-head">
              <b>{{ BAND_META[b.key].icon }} {{ BAND_META[b.key].name }}</b>
              <em class="muted">{{ BAND_META[b.key].range }}</em>
              <span v-if="b.key === 'night'" class="tag">跨日</span>
            </div>
            <div class="band-flow muted">班段客流合计 {{ b.flow }} · 峰值 {{ b.peak }}</div>
            <div class="need-row" :class="b.gGuard.level">
              <span>🛡️ 保安</span>
              <b>需 {{ b.need_guard }}</b>
              <em>缺 {{ b.gGuard.gap }}</em>
            </div>
            <div class="need-row" :class="b.gClean.level">
              <span>🧹 保洁</span>
              <b>需 {{ b.need_clean }}</b>
              <em>缺 {{ b.gClean.gap }}</em>
            </div>
            <div class="need-row" :class="b.gRepair.level">
              <span>🔧 维修工</span>
              <b>需 {{ b.need_repair }}</b>
              <em>缺 {{ b.gRepair.gap }}</em>
            </div>
            <div v-if="b.orders.length" class="band-refs">
              <em v-for="o in b.orders" :key="o.id" class="ref-order" :class="o.status">{{ o.code }} · {{ o.ride_name }}</em>
            </div>
            <div v-if="b.complaints.length" class="band-refs">
              <em v-for="c in b.complaints" :key="c.id" class="ref-comp" :class="'sev'+c.severity">{{ c.code }} · {{ c.roles.join('/') }}</em>
            </div>
            <div v-if="b.blockN" class="band-alert">⛔ {{ b.blockN }} 项硬缺岗（检修中/紧急投诉）</div>
            <div v-else-if="b.warnN" class="band-warn">⚠️ {{ b.warnN }} 项缺口</div>
            <div v-else class="band-ok">✅ 覆盖满足</div>
          </div>
        </div>

        <div class="plan-warnings" v-if="planDayData.warnings.length">
          <h4>缺口明细（{{ planDayData.warnings.length }}）</h4>
          <div v-for="(w, i) in planDayData.warnings" :key="i" class="pw-item" :class="w.level">
            <b>{{ warnIcon(w.level) }} {{ w.msg }}</b>
            <span class="tag" v-if="w.band">{{ BAND_META[w.band]?.name }}</span>
          </div>
        </div>
        <p class="muted tips">
          补位规则：自动选择当日无排班、无前日夜班（疲劳规避）、区域/技能最匹配且近三日负载最低的员工；
          已开始班段的硬需求优先排未开始的邻班接续，仍无法补位时生成紧急加班调令（1.5 倍时薪、主管审批后写入考勤顺延下班）。
        </p>
      </div>
    </template>

    <!-- ============ 跨日计划预览与审批 ============ -->
    <template v-else-if="tab === 'plan'">
      <div class="card plan-approval-head">
        <div class="dh-row">
          <div class="dh-mode">
            <h3>🧾 跨日排班计划预览与审批</h3>
            <p class="muted">
              引擎融合未来三天的<b>分时预约客流</b>、<b>在途检修工单</b>与<b>待处置投诉优先级</b>生成跨日补班草案（含跨日夜班与紧急加班调令）。
              主管预览逐日「需求 X 人 / 在岗 Y 人 / 缺口 Z 人」与预计工资后<b>一键批准</b>——全部排班与调令在同一事务原子落地；
              驳回 / 废弃零副作用。计划等待期间客流或工单变化会自动标记「需求已变化」。
            </p>
          </div>
          <div class="dh-actions">
            <label class="mode-switch plan-switch">
              <input type="checkbox" :checked="planApprovalOn" @change="togglePlanApproval($event.target.checked)" />
              审批模式（{{ planApprovalOn ? '已开启' : '已关闭' }}）
            </label>
            <button class="primary" :disabled="planBusy || !planApprovalOn" @click="genPlan">
              {{ planBusy ? '测算中…' : (pendingPlan ? '🔄 按最新需求刷新计划' : '➕ 生成跨日计划') }}
            </button>
          </div>
        </div>
        <em class="mmsg" :class="{ bad: planMsg.startsWith('✖') }">{{ planMsg }}</em>
        <p v-if="!planApprovalOn" class="muted tips warn-tip">
          当前为「直接补位」模式：动态调度每小时直接写排班。勾选上方审批模式后，补位将统一走跨日计划草案 → 主管审批流程。
        </p>
      </div>

      <div class="tabs sub-tabs">
        <button :class="{ on: planTab === 'pending' }" @click="planTab = 'pending'">
          待审批计划
          <i v-if="stats.pendingPlan" class="badge-dot" :class="{ 'stale-dot': stats.pendingPlanStale }">{{ stats.pendingPlanItems }}</i>
        </button>
        <button :class="{ on: planTab === 'history' }" @click="loadHistory(); planTab = 'history'">历史计划</button>
      </div>

      <!-- 待审批 -->
      <template v-if="planTab === 'pending'">
        <div v-if="!pendingPlan" class="card empty-plan">
          <p>📭 暂无待审批的跨日排班计划。</p>
          <p class="muted tips">开启审批模式后引擎每小时巡检会自动生成草案；也可点击上方「生成跨日计划」立即测算。</p>
        </div>

        <template v-else>
          <!-- 计划总览 -->
          <div class="card plan-overview" :class="{ stale: pendingPlan.is_stale }">
            <div class="po-head">
              <div>
                <h3>{{ pendingPlan.code }}
                  <span class="abadge" :class="PLAN_STATUS_META[pendingPlan.status]?.cls">待主管审批</span>
                  <span v-if="pendingPlan.is_stale" class="abadge stale-badge">🔶 需求已变化，建议刷新</span>
                </h3>
                <p class="muted">
                  覆盖第 {{ pendingPlan.day_from }} ~ {{ pendingPlan.day_to }} 天 · 生成于第{{ pendingPlan.create_day }}天 ·
                  {{ pendingPlan.source === 'engine' ? '引擎自动测算' : '主管手动生成' }} · {{ pendingPlan.reason }}
                </p>
              </div>
              <div class="po-actions">
                <button class="ghost sm" @click="openPlanLogs(pendingPlan)">时间线</button>
                <button class="succ" :disabled="planBusy" @click="approvePlan">✅ 批准并落地</button>
                <button class="danger" :disabled="planBusy" @click="rejectPlan">驳回</button>
                <button class="ghost sm" :disabled="planBusy" @click="discardPlan">废弃</button>
              </div>
            </div>
            <div class="po-kpis">
              <div><b>{{ pendingPlan.pending_items }}</b><em>待落地项</em></div>
              <div><b>{{ stats.pendingPlanSchedules }}</b><em>补班排班</em></div>
              <div><b>{{ stats.pendingPlanOvertimes }}</b><em>紧急加班调令</em></div>
              <div><b>¥{{ (pendingPlan.est_wage || 0).toLocaleString() }}</b><em>预计新增工资</em></div>
              <div :class="{ neg: pendingPlan.gap_before > 0 }">
                <b>{{ pendingPlan.gap_before }} → {{ pendingPlan.gap_after }}</b><em>岗位缺口（落地前→后）</em>
              </div>
            </div>
            <p class="muted tips">
              工资为按当前日薪测算的预估值：补班按班次基准工时、调令按 1.5 倍时薪在下班结算时逐单入「工资」流水；
              批准时如遇他人已手排造成同日冲突、员工离岗或班段已过，对应项自动<b>跳过并留痕</b>，其余项正常落地，提交后引擎再按最新需求补缺。
            </p>
          </div>

          <!-- 逐日预览 -->
          <div class="card plan-day" v-for="g in pendingPlan.dayGroups" :key="g.day">
            <div class="pd-head">
              <b>{{ planDayName(g.day) }}</b>
              <span class="muted">预测客流 {{ g.demand.flowTotal }} 人 · 在途工单 {{ g.demand.openOrders }} · 待处置投诉 {{ g.demand.openComplaints }}</span>
              <span class="gap-chip" :class="{ zero: g.gap_total_after === 0, hard: g.hard_after }">
                缺口 {{ g.gap_total_before }} → {{ g.gap_total_after }}
              </span>
            </div>

            <!-- 班段 × 岗位覆盖对比 -->
            <div class="pd-bands">
              <div class="pd-band" v-for="b in g.bands" :key="b.key"
                   :class="{ hard: b.hard_after, covered: b.gap_after === 0 }">
                <b>{{ BAND_META[b.key].icon }} {{ b.label }}</b>
                <em v-if="b.add_schedules || b.add_overtimes" class="add-tag">
                  ＋{{ b.add_schedules }} 排班<span v-if="b.add_overtimes"> · ＋{{ b.add_overtimes }} 调令</span>
                </em>
                <em v-else class="muted">无需调整</em>
                <span class="muted">缺口 {{ b.gap_before }} → {{ b.gap_after }}</span>
              </div>
            </div>

            <!-- 当日明细 -->
            <div class="pd-items" v-if="itemsOfDay(g.day).length">
              <div class="pdi pdi-head">
                <span>动作</span><span>员工 / 岗位</span><span>班段</span><span>拟安排</span><span>需求依据（客流/工单/投诉 · 优先级）</span><span>预计工资</span>
              </div>
              <div class="pdi" v-for="it in itemsOfDay(g.day)" :key="it.id" :class="it.action">
                <span>
                  <i class="pdi-dot" :class="it.action"></i>
                  {{ it.action === 'add_schedule' ? '补班' : '🆘 紧急调令' }}
                </span>
                <span><b>{{ it.staff_name }}</b><em class="muted">{{ it.staff_role }}</em></span>
                <span>{{ BAND_META[it.band]?.name }}</span>
                <span>
                  <i class="dot-sh" :style="{ background: it.shift_color }"></i>{{ it.shift_name }}
                  <em class="muted">{{ it.cross_day_time }}</em>
                  <em v-if="it.action === 'add_overtime'" class="ot-tag">加班 {{ it.ot_ticks }}h（1.5×）</em>
                </span>
                <span class="pdi-reason">
                  {{ it.demand_reason }}
                  <em v-for="r in it.refs" :key="r.kind + r.id" class="ref-pill"
                     :class="r.kind === 'order' ? 'ref-order' : ['', '', 'sev2', 'sev3'][r.severity]">
                    {{ r.kind === 'order' ? '🔧' : '📣' }}{{ r.code }} · P{{ r.priority }}
                  </em>
                </span>
                <span class="money neg">¥{{ it.est_wage }}</span>
              </div>
            </div>
          </div>
        </template>
      </template>

      <!-- 历史 -->
      <template v-else>
        <div class="card plan-history">
          <div v-if="!planHistory.length" class="muted empty">暂无历史计划。</div>
          <div class="ph-row" v-for="p in planHistory" :key="p.id">
            <span class="mono">{{ p.code }}</span>
            <span class="abadge" :class="PLAN_STATUS_META[p.status]?.cls">{{ PLAN_STATUS_META[p.status]?.label || p.status }}</span>
            <span class="muted">第{{ p.day_from }}~{{ p.day_to }}天</span>
            <span>补位 {{ p.item_count }} 项</span>
            <span>落地 <b>{{ p.applied_count }}</b> / 跳过 {{ p.skipped_count }}</span>
            <span class="money neg">¥{{ p.est_wage }}</span>
            <span class="muted" v-if="p.handle_note">{{ p.handle_note }}</span>
            <button class="ghost sm" @click="openPlanLogs(p)">时间线</button>
          </div>
        </div>
      </template>
    </template>

    <!-- ============ 排班看板 ============ -->
    <template v-else-if="tab === 'board'">
      <div class="board-wrap card">
        <div class="board">
          <div class="bcol corner">
            <span class="muted">员工 ＼ 日期</span>
            <div class="shift-legend">
              <i v-for="sh in store.shifts" :key="sh.id" :style="{ background: sh.color }">{{ sh.name }}<em>{{ sh.time_text }}</em></i>
            </div>
          </div>
          <div class="bcol" v-for="d in days" :key="d">
            <div class="day-head" :class="{ today: d === today }">{{ dayNames(d) }}<em>第 {{ d }} 天</em></div>
          </div>

          <template v-for="st in nonSupervisor" :key="st.id">
            <div class="bcol corner staff-cell">
              <b>{{ st.name }}</b><em class="muted">{{ st.role }} · {{ store.zones.find(z => z.id === st.zone_id)?.name || '—' }}</em>
            </div>
            <div class="bcol" v-for="d in days" :key="st.id + '-' + d">
              <div v-if="schedOf(st.id, d)" class="shift-card"
                   :class="schedState(schedOf(st.id, d)).cls"
                   :style="{ borderColor: schedOf(st.id, d).shift_color + '88' }">
                <div class="sc-top">
                  <span class="sc-name" :style="{ color: schedOf(st.id, d).shift_color }">{{ schedOf(st.id, d).shift_name }}</span>
                  <span class="sc-state">{{ schedState(schedOf(st.id, d)).text }}</span>
                </div>
                <div class="sc-time muted">{{ schedOf(st.id, d).time_text }}</div>
                <div class="sc-tags">
                  <em class="src-tag" v-if="schedOf(st.id, d).source">{{ SOURCE_LABEL[schedOf(st.id, d).source] || schedOf(st.id, d).source }}</em>
                  <em v-if="schedOf(st.id, d).late">迟到</em>
                  <em v-if="schedOf(st.id, d).ot_approved">加班{{ schedOf(st.id, d).overtime_ticks }}h</em>
                  <em v-if="schedOf(st.id, d).work_ticks">出勤{{ schedOf(st.id, d).work_ticks }}h</em>
                  <em v-if="schedOf(st.id, d).pay" class="money neg">¥{{ schedOf(st.id, d).pay }}</em>
                </div>
                <div class="sc-actions">
                  <button class="ghost sm" @click="openLogs(schedOf(st.id, d))">时间线</button>
                  <button v-if="!schedOf(st.id, d).att_status && schedOf(st.id, d).status !== 'cancelled'" class="ghost sm"
                          @click="checkin(schedOf(st.id, d))">打卡</button>
                  <button v-if="schedOf(st.id, d).on_duty" class="ghost sm danger" @click="leave(schedOf(st.id, d))">离岗</button>
                  <button v-if="!schedOf(st.id, d).att_status && schedOf(st.id, d).status !== 'cancelled'" class="ghost sm"
                          @click="swapDraft(schedOf(st.id, d)).open = !swapDraft(schedOf(st.id, d)).open">调班</button>
                  <button v-if="schedOf(st.id, d).on_duty" class="ghost sm"
                          @click="otDraft(schedOf(st.id, d)).open = !otDraft(schedOf(st.id, d)).open">加班</button>
                  <button v-if="!schedOf(st.id, d).att_status && schedOf(st.id, d).status !== 'cancelled'" class="ghost sm danger"
                          @click="cancelS(schedOf(st.id, d))">取消</button>
                </div>
                <!-- 调班申请 -->
                <div class="inline-form" v-if="swaps[schedOf(st.id, d).id]?.open">
                  <select v-model.number="swaps[schedOf(st.id, d).id].target_staff_id">
                    <option :value="null" disabled>代班同事…</option>
                    <option v-for="t in nonSupervisor.filter(x => x.id !== st.id)" :key="t.id" :value="t.id">{{ t.name }} · {{ t.role }}</option>
                  </select>
                  <select v-model.number="swaps[schedOf(st.id, d).id].target_shift_id">
                    <option v-for="sh in store.shifts" :key="sh.id" :value="sh.id">{{ sh.name }} {{ sh.time_text }}</option>
                  </select>
                  <select v-model.number="swaps[schedOf(st.id, d).id].target_day">
                    <option v-for="dd in days" :key="dd" :value="dd">{{ dayNames(dd) }}</option>
                  </select>
                  <input v-model="swaps[schedOf(st.id, d).id].reason" placeholder="调班原因（可选）" maxlength="120" />
                  <button class="succ sm" @click="submitSwap(schedOf(st.id, d))">提交主管审批</button>
                </div>
                <!-- 加班申请 -->
                <div class="inline-form" v-if="otForm[schedOf(st.id, d).id]?.open">
                  <span class="muted sm-text">延后下班</span>
                  <select v-model.number="otForm[schedOf(st.id, d).id].ticks">
                    <option :value="1">1h</option><option :value="2">2h</option><option :value="3">3h</option><option :value="4">4h</option>
                  </select>
                  <input v-model="otForm[schedOf(st.id, d).id].reason" placeholder="加班事由（可选）" maxlength="120" />
                  <button class="succ sm" @click="submitOt(schedOf(st.id, d))">提交加班申请</button>
                </div>
              </div>
              <span v-else class="rest muted">休</span>
            </div>
          </template>
        </div>
      </div>

      <!-- 主管排班 -->
      <div class="card assign-card">
        <h3>🧑‍💼 运营主管排班</h3>
        <div class="assign-row">
          <label>员工
            <select v-model.number="form.staff_id">
              <option :value="null" disabled>选择员工…</option>
              <option v-for="s in nonSupervisor" :key="s.id" :value="s.id">{{ s.name }} · {{ s.role }} · {{ store.zones.find(z => z.id === s.zone_id)?.name }}</option>
            </select>
          </label>
          <label>班次
            <select v-model.number="form.shift_id">
              <option :value="null" disabled>选择班次…</option>
              <option v-for="sh in store.shifts" :key="sh.id" :value="sh.id">{{ sh.name }} · {{ sh.time_text }} · 基准 {{ sh.standard_hours }}h</option>
            </select>
          </label>
          <label>日期
            <select v-model.number="form.day">
              <option v-for="d in days" :key="d" :value="d">{{ dayNames(d) }}（第 {{ d }} 天）</option>
            </select>
          </label>
          <button class="primary" @click="submitSchedule">排入班次</button>
          <em class="mmsg" :class="{ bad: formMsg.includes('失败') || formMsg.includes('冲突') || formMsg.includes('不能') }">{{ formMsg }}</em>
        </div>
        <p class="muted tips">说明：同一员工同日仅允许一个有效排班（冲突拦截）；跨日夜班当日 17:00 上班、次日 09:00 下班并结算，看板以「当夜值守 / 凌晨值守」区分跨日状态。开启动态调度时引擎会按客流/工单/投诉需求自动补位，也可在「动态调度」页一键执行。</p>
      </div>
    </template>

    <!-- ============ 考勤工时 ============ -->
    <template v-else-if="tab === 'attendance'">
      <div class="card">
        <div class="tabs">
          <button :class="{ on: attTab === 'today' }" @click="attTab = 'today'">今日结算</button>
          <button :class="{ on: attTab === 'onduty' }" @click="attTab = 'onduty'">在岗中（含跨日夜班）</button>
          <button :class="{ on: attTab === 'absent' }" @click="attTab === 'absent' ? attTab = 'all' : attTab = 'absent'">旷工/离岗</button>
        </div>
        <div class="atable">
          <div class="ahead"><span>考勤号</span><span>员工</span><span>班次</span><span>状态</span><span>出勤</span><span>加班</span><span>满意度</span><span>结算工资</span><span>结算日</span><span></span></div>
          <div class="arow" v-for="a in attendanceList" :key="a.id">
            <span class="mono">{{ a.code }}</span>
            <span><b>{{ a.staff_name }}</b><em class="muted">{{ a.staff_role }}</em></span>
            <span><i class="dot-sh" :style="{ background: a.shift_color }"></i>{{ a.shift_name }}<em class="muted">{{ a.time_text }}</em></span>
            <span><span class="abadge" :class="statusMeta(a.status).cls">{{ statusMeta(a.status).label }}</span><em v-if="a.late" class="late-tag">迟到</em></span>
            <span>{{ a.status === 'checked_in' ? '进行中' : a.work_ticks + 'h' }}</span>
            <span>{{ a.ot_approved ? a.overtime_ticks + 'h（1.5×）' : '—' }}</span>
            <span :class="a.satisfaction_delta > 0 ? 'pos' : a.satisfaction_delta < 0 ? 'neg' : ''">
              {{ a.satisfaction_delta ? (a.satisfaction_delta > 0 ? '+' : '') + a.satisfaction_delta : '—' }}
            </span>
            <span class="money neg" v-if="a.pay">¥{{ a.pay.toLocaleString() }}</span>
            <span class="muted" v-else>—</span>
            <span>第{{ a.settle_day || a.day }}天</span>
            <span><button class="ghost sm" @click="openLogs({ id: a.schedule_id, attendance_id: a.id, staff_name: a.staff_name, day: a.day, shift_name: a.shift_name })">时间线</button></span>
          </div>
          <div class="muted empty" v-if="!attendanceList.length">暂无考勤记录，引擎会在班次开始时自动打卡。</div>
        </div>
        <p class="muted tips">工资口径：时薪 = 日薪 ÷ 5；下班按班次基准工时结算，加班按 1.5 倍时薪另计，旷工无薪，中途离岗按实际出勤比例折算。每张考勤单下班时逐条写入「工资」财务流水；跨日夜班次日 09:00 下班、结算计入次日工资。</p>
      </div>
    </template>

    <!-- ============ 调班 / 加班 ============ -->
    <template v-else-if="tab === 'requests'">
      <div class="card">
        <div class="tabs">
          <button :class="{ on: reqTab === 'pending' }" @click="reqTab = 'pending'">待审批（{{ stats.pendingRequests }}）</button>
          <button :class="{ on: reqTab === 'approved' }" @click="reqTab = 'approved'">已批准</button>
          <button :class="{ on: reqTab === 'rejected' }" @click="reqTab = 'rejected'">已驳回</button>
          <button :class="{ on: reqTab === 'all' }" @click="reqTab = 'all'">全部</button>
        </div>
        <div class="reqlist">
          <div class="req card2" v-for="r in requestList" :key="r.id" :class="{ dispatch: r.source === 'dispatch' }">
            <div class="rq-head">
              <span class="rq-kind" :class="r.kind">
                {{ r.source === 'dispatch' ? '🆘 系统紧急调令' : (r.kind === 'swap' ? '🔄 调班申请' : '🕑 加班申请') }}
              </span>
              <span class="mono muted">{{ r.code }}</span>
              <span class="abadge" :class="reqStatusMeta(r.status).cls">{{ reqStatusMeta(r.status).label }}</span>
            </div>
            <div class="rq-body">
              <template v-if="r.kind === 'swap'">
                <b>{{ r.staff_name }}</b><em class="muted">（{{ r.staff_role }} · 第{{ r.day }}天 {{ r.shift_name }}）</em>
                <span class="arrow">→</span>
                <b>{{ r.target_name }}</b><em class="muted">（{{ r.target_role }}）</em>
                <span class="tag">{{ dayNames2(r.target_day) }} · {{ r.target_shift_name }}{{ r.target_cross_day ? '（跨日）' : '' }}</span>
              </template>
              <template v-else>
                <b>{{ r.staff_name }}</b><em class="muted">（{{ r.staff_role }} · 当值 {{ r.shift_name }}）</em>
                <span class="tag ot">申请延后下班 +{{ r.ot_ticks }}h（1.5 倍时薪）</span>
              </template>
              <p class="muted reason" v-if="r.reason">事由：{{ r.reason }}</p>
              <p class="muted reason" v-if="r.handle_note">处理：{{ r.handle_note }}</p>
            </div>
            <div class="rq-foot">
              <button class="ghost sm" @click="openReqLogs(r)">时间线</button>
              <template v-if="r.status === 'pending'">
                <button class="succ sm" @click="approve(r)">主管批准</button>
                <button class="danger sm" @click="reject(r)">驳回</button>
                <button v-if="r.source !== 'dispatch'" class="ghost sm" @click="withdraw(r)">员工撤回</button>
              </template>
            </div>
          </div>
          <div class="muted empty" v-if="!requestList.length">暂无调班 / 加班申请。</div>
        </div>
      </div>
    </template>

    <!-- ============ 岗位覆盖 ============ -->
    <template v-else>
      <div class="day-picker">
        <button v-for="d in days" :key="d" :class="{ on: coverageDay === d }" @click="loadCoverage(d)">{{ dayNames(d) }} · 第{{d}}天</button>
      </div>
      <div class="card coverage">
        <h3>🛡️ 岗位覆盖校验（第 {{ coverageDay }} 天 · 在岗花名册 {{ coverage.rosterCount }} 人）</h3>
        <div v-if="!coverage.warnings.length" class="ok-box">✅ 各开放区域、预约客流高峰、在途检修工单与待处置投诉的岗位覆盖齐全。</div>
        <div v-for="(w, i) in coverage.warnings" :key="i" class="warn-item" :class="w.level">
          <b>{{ warnIcon(w.level) }} {{ w.msg }}</b>
          <span class="tag">{{ w.band ? BAND_META[w.band]?.name : (w.type === 'maintenance' ? '设施检修' : w.type.startsWith('zone') ? '区域岗位' : '投诉处置') }}</span>
        </div>
        <p class="muted tips">
          覆盖规则：班段 × 岗位（保安/保洁/维修）需求由预约客流、在途检修工单与待处置投诉共同驱动；
          缺口在未来班段为黄色预警（引擎自动补位/主管调班），当天班段已开始且为检修中工单或紧急投诉时为 ⛔ 红色硬缺岗，
          会自动生成紧急加班调令。真正的同日重复排班为硬冲突，在排班与调班审批时拦截。
        </p>
      </div>
    </template>

    <!-- 时间线弹窗 -->
    <div class="modal-mask" v-if="detailLogs.length" @click.self="closeLogs">
      <div class="modal card">
        <h3>🕓 排班时间线 · {{ detailTitle }}</h3>
        <div class="tl" v-for="l in detailLogs" :key="l.id">
          <span class="tl-time muted">第{{ l.day }}天 {{ String(l.hour).padStart(2, '0') }}:00</span>
          <b>{{ ACTION_LABEL[l.action] || l.action }}</b>
          <em class="muted">{{ l.note }}</em>
          <span class="muted" v-if="l.staff_name">👤 {{ l.staff_name }}</span>
          <span class="muted" v-if="l.approver_name">🧑‍💼 {{ l.approver_name }}</span>
        </div>
        <div class="muted empty" v-if="!detailLogs.length">暂无记录</div>
        <button class="ghost" @click="closeLogs">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sch { display: flex; flex-direction: column; gap: 14px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; gap: 2px; padding: 14px; }
.stat span { font-size: 20px; }
.stat b { font-size: 24px; }
.stat b.on { color: var(--green); }
.stat em { font-style: normal; color: var(--muted); font-size: 12px; }
.stat.alert { border-color: rgba(255,107,107,.5); }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.card-tabs { padding: 10px 14px; background: none; border: none; }
.tabs button { position: relative; }
.tabs button.on { background: rgba(255,107,107,.18); border-color: rgba(255,107,107,.5); color: var(--accent); }
.badge-dot { font-style: normal; background: var(--accent); color: #fff; border-radius: 20px; font-size: 10px; padding: 0 6px; margin-left: 4px; }
.alert-dot { background: var(--red); }
.autofill { margin-left: auto; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }

/* 动态调度 */
.dispatch-head { display: flex; flex-direction: column; gap: 12px; }
.dh-row { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dh-mode { flex: 1; min-width: 280px; }
.dh-mode h3 { margin: 0 0 6px; }
.dh-mode p { margin: 0; font-size: 12px; line-height: 1.7; }
.dh-actions { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.mode-switch { font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
.mode-switch select { min-width: 220px; }
.dh-params { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; }
.dh-params label { font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
.dh-params input { width: 110px; }
.mmsg { font-size: 12px; color: var(--green); }
.mmsg.bad { color: var(--red); }
.day-picker { display: flex; gap: 8px; flex-wrap: wrap; }
.day-picker button { padding: 7px 14px; border-radius: 18px; border: 1px solid var(--border); background: var(--panel); cursor: pointer; font-size: 13px; }
.day-picker button.on { background: rgba(255,107,107,.16); border-color: rgba(255,107,107,.5); color: var(--accent); font-weight: 700; }
.plan-card { display: flex; flex-direction: column; gap: 12px; }
.plan-summary { display: flex; gap: 18px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.plan-summary b { color: var(--text); font-size: 15px; margin: 0 2px; }
.band-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.band-col { border: 1px solid var(--border); border-radius: 12px; padding: 12px; background: var(--panel2); display: flex; flex-direction: column; gap: 7px; }
.band-col.blocked { border-color: rgba(255,107,107,.5); background: rgba(255,107,107,.06); }
.band-head { display: flex; align-items: center; gap: 8px; }
.band-head em { font-style: normal; font-size: 11px; }
.band-flow { font-size: 11px; }
.need-row { display: flex; justify-content: space-between; align-items: center; font-size: 13px; padding: 4px 8px; border-radius: 8px; background: rgba(255,255,255,.03); }
.need-row b { font-weight: 600; }
.need-row em { font-style: normal; font-size: 12px; color: var(--muted); }
.need-row.block em, .need-row.warn em { color: var(--red); font-weight: 700; }
.need-row.block { background: rgba(255,107,107,.1); }
.need-row.warn { background: rgba(255,209,102,.08); }
.band-refs { display: flex; flex-direction: column; gap: 3px; }
.ref-order, .ref-comp { font-style: normal; font-size: 10px; padding: 2px 7px; border-radius: 8px; background: rgba(102,166,255,.12); color: var(--blue); }
.ref-order.processing { background: rgba(255,107,107,.15); color: var(--red); }
.ref-comp.sev3 { background: rgba(255,107,107,.15); color: var(--red); }
.ref-comp.sev2 { background: rgba(255,209,102,.15); color: var(--accent2); }
.band-alert { font-size: 12px; color: var(--red); font-weight: 700; margin-top: auto; }
.band-warn { font-size: 12px; color: var(--accent2); margin-top: auto; }
.band-ok { font-size: 12px; color: var(--green); margin-top: auto; }
.plan-warnings h4 { margin: 4px 0; font-size: 13px; }
.pw-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; margin-bottom: 6px; font-size: 12px; background: rgba(255,209,102,.07); border: 1px solid rgba(255,209,102,.25); }
.pw-item.block { background: rgba(255,107,107,.09); border-color: rgba(255,107,107,.4); }

/* 排班看板 */
.board-wrap { overflow-x: auto; padding: 14px; }
.board { display: grid; grid-template-columns: 170px repeat(4, minmax(190px, 1fr)); gap: 8px; min-width: 960px; }
.bcol { min-height: 64px; }
.corner { display: flex; flex-direction: column; justify-content: center; gap: 6px; font-size: 12px; padding: 4px; }
.day-head { text-align: center; font-weight: 700; padding: 8px; border-radius: 10px; background: var(--panel2); border: 1px solid var(--border); }
.day-head.today { color: var(--accent); border-color: rgba(255,107,107,.5); }
.day-head em { display: block; font-style: normal; font-weight: 400; font-size: 11px; color: var(--muted); }
.staff-cell { border-bottom: 1px solid var(--border); }
.staff-cell em { font-style: normal; font-size: 11px; }
.shift-legend { display: flex; flex-wrap: wrap; gap: 6px; }
.shift-legend i { font-style: normal; font-size: 10px; color: #fff; padding: 1px 7px; border-radius: 10px; display: inline-flex; gap: 4px; align-items: center; }
.shift-legend i em { font-style: normal; opacity: .85; font-size: 9px; }
.shift-card { background: var(--panel2); border: 1px solid var(--border); border-left-width: 3px; border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.shift-card.absent { border-color: var(--red) !important; background: rgba(255,107,107,.1); }
.shift-card.leave { opacity: .75; }
.shift-card.night { background: rgba(167,139,250,.12); border-color: rgba(167,139,250,.5) !important; }
.shift-card.dispatch { border-left-color: var(--green) !important; }
.sc-top { display: flex; justify-content: space-between; align-items: center; }
.sc-name { font-weight: 700; font-size: 13px; }
.sc-state { font-size: 11px; color: var(--muted); }
.sc-time { font-size: 11px; }
.sc-tags { display: flex; gap: 4px; flex-wrap: wrap; }
.sc-tags em { font-style: normal; font-size: 10px; background: rgba(102,166,255,.15); color: var(--blue); border-radius: 8px; padding: 0 6px; }
.sc-tags em.src-tag { background: rgba(109,213,160,.15); color: var(--green); }
.sc-tags em.money { background: rgba(109,213,160,.15); color: var(--green); }
.sc-actions { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px; }
.sm { padding: 3px 8px; font-size: 11px; }
.inline-form { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border); }
.inline-form input, .inline-form select { font-size: 12px; padding: 5px 8px; }
.rest { font-size: 12px; opacity: .5; }

.assign-card { margin-top: 0; }
.assign-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.assign-row label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.tips { margin-top: 10px; font-size: 12px; line-height: 1.6; }

/* 考勤表 */
.atable { display: flex; flex-direction: column; }
.ahead, .arow { display: grid; grid-template-columns: .8fr 1fr 1.4fr .9fr .7fr 1fr .7fr .9fr .7fr .7fr; gap: 8px; padding: 10px 8px; font-size: 13px; align-items: center; }
.ahead { color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--border); }
.arow { border-bottom: 1px solid var(--border); }
.arow em { display: block; font-style: normal; font-size: 11px; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); }
.abadge { font-size: 11px; padding: 2px 8px; border-radius: 12px; border: 1px solid var(--border); }
.abadge.st-on { color: var(--green); border-color: rgba(109,213,160,.5); background: rgba(109,213,160,.1); }
.abadge.st-out { color: var(--muted); }
.abadge.st-absent { color: var(--red); border-color: rgba(255,107,107,.5); background: rgba(255,107,107,.1); }
.abadge.st-leave { color: var(--accent2); border-color: rgba(255,209,102,.4); }
.late-tag { font-style: normal; font-size: 10px; color: var(--accent2); margin-left: 4px; }
.dot-sh { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
.pos { color: var(--green); } .neg { color: var(--red); }
.empty { padding: 18px; text-align: center; }

/* 申请 */
.reqlist { display: flex; flex-direction: column; gap: 10px; }
.card2 { background: var(--panel2); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
.req.dispatch { border-color: rgba(255,107,107,.5); background: rgba(255,107,107,.05); }
.rq-head { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
.rq-kind { font-weight: 700; font-size: 13px; }
.rq-kind.swap { color: var(--blue); } .rq-kind.overtime, .rq-kind { color: var(--purple); }
.rq-body { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.rq-body em { font-style: normal; font-size: 12px; }
.arrow { color: var(--muted); }
.rq-body .tag.ot { color: var(--accent2); border-color: rgba(255,209,102,.4); }
.reason { width: 100%; font-size: 12px; }
.rq-foot { display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end; }

/* 覆盖 */
.coverage .warn-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-radius: 10px; margin-bottom: 8px; background: rgba(255,209,102,.08); border: 1px solid rgba(255,209,102,.3); }
.coverage .warn-item.block { background: rgba(255,107,107,.1); border-color: rgba(255,107,107,.45); }
.ok-box { padding: 16px; text-align: center; color: var(--green); background: rgba(109,213,160,.08); border: 1px solid rgba(109,213,160,.3); border-radius: 10px; }

/* 跨日计划 */
.plan-switch { flex-direction: row !important; align-items: center; gap: 6px; white-space: nowrap; }
.plan-switch input { width: auto; }
.stale-dot { background: var(--accent2, #ffd166) !important; }
.warn-tip { color: var(--accent2, #ffd166) !important; }
.sub-tabs { margin: 4px 0 0; }
.empty-plan { padding: 30px; text-align: center; }
.empty-plan p { margin: 6px 0; }
.plan-overview { border-color: rgba(102,166,255,.4); }
.plan-overview.stale { border-color: rgba(255,209,102,.6); background: rgba(255,209,102,.05); }
.po-head { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.po-head h3 { margin: 0 0 6px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.po-actions { display: flex; gap: 8px; align-items: center; }
.po-kpis { display: flex; gap: 22px; flex-wrap: wrap; margin: 14px 0 6px; }
.po-kpis div { display: flex; flex-direction: column; }
.po-kpis b { font-size: 20px; }
.po-kpis em { font-style: normal; font-size: 11px; color: var(--muted); }
.po-kpis div.neg b { color: var(--red); }
.stale-badge { color: var(--accent2, #ffd166) !important; border-color: rgba(255,209,102,.5) !important; background: rgba(255,209,102,.12) !important; }
.plan-day { display: flex; flex-direction: column; gap: 10px; }
.pd-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.pd-head b { font-size: 15px; }
.gap-chip { margin-left: auto; font-size: 12px; padding: 3px 10px; border-radius: 12px; background: rgba(255,209,102,.15); color: var(--accent2, #ffd166); border: 1px solid rgba(255,209,102,.35); }
.gap-chip.zero { background: rgba(109,213,160,.12); color: var(--green); border-color: rgba(109,213,160,.35); }
.gap-chip.hard { background: rgba(255,107,107,.14); color: var(--red); border-color: rgba(255,107,107,.4); }
.pd-bands { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
.pd-band { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 3px; font-size: 12px; background: var(--panel2); }
.pd-band.hard { border-color: rgba(255,107,107,.45); }
.pd-band.covered { border-color: rgba(109,213,160,.35); }
.pd-band em { font-style: normal; }
.add-tag { color: var(--green); font-weight: 700; }
.pd-items { display: flex; flex-direction: column; border-top: 1px dashed var(--border); }
.pdi { display: grid; grid-template-columns: 90px 130px 60px 1.2fr 2.2fr 90px; gap: 10px; padding: 9px 6px; align-items: center; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,.05); }
.pdi-head { color: var(--muted); font-size: 11px; }
.pdi span { display: flex; flex-direction: column; gap: 2px; }
.pdi em { font-style: normal; font-size: 11px; }
.pdi-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
.pdi-dot.add_schedule { background: var(--green); }
.pdi-dot.add_overtime { background: var(--red); }
.pdi.add_overtime { background: rgba(255,107,107,.05); }
.ot-tag { color: var(--red); font-weight: 700; font-style: normal !important; }
.pdi-reason { flex-direction: row !important; flex-wrap: wrap; gap: 4px; font-size: 12px; color: var(--muted); align-items: center; }
.ref-pill { font-style: normal; font-size: 10px; padding: 1px 7px; border-radius: 8px; background: rgba(102,166,255,.12); color: var(--blue); }
.ref-pill.sev3 { background: rgba(255,107,107,.16); color: var(--red); }
.ref-pill.sev2 { background: rgba(255,209,102,.16); color: var(--accent2, #ffd166); }
.plan-history { display: flex; flex-direction: column; }
.ph-row { display: flex; gap: 14px; align-items: center; padding: 10px 6px; border-bottom: 1px solid var(--border); font-size: 13px; flex-wrap: wrap; }

/* 弹窗 */
.modal-mask { position: fixed; inset: 0; background: rgba(5,8,18,.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { width: 560px; max-width: 92vw; max-height: 80vh; overflow-y: auto; }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 8px 4px; border-bottom: 1px dashed var(--border); font-size: 13px; }
.tl .tl-time { font-size: 11px; min-width: 74px; }
</style>
