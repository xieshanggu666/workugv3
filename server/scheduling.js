import db, { getSetting, setSetting, tx } from './db.js'
import {
  BANDS as FLOW_BANDS, GUARD_ROLE_SET,
  avgWalkinByHour, hourlyForecast, complaintPriority, maintenancePriority
} from './flow.js'

// 员工排班与工时结算模块：
// 班次模板 → 排班（校验冲突/岗位覆盖）→ 考勤打卡（迟到/在岗/离岗）→ 调班/加班协作（主管审批）
// → 下班自动结算工时与满意度，基准工时工资 + 1.5 倍加班工资逐条进入工资财务流水；跨日夜班次日结算。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

const OPEN_HOUR = 9
const CLOSE_HOUR = 18
const HOURS_PER_DAY = 10

// 由 index.js 注入：财务流水、岗位覆盖所需的投诉岗位映射
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), OPEN_HOUR),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null,
  complaintRoles: null   // { category: [岗位...] }
}
export function initSchedulingContext(deps) {
  Object.assign(ctx, deps)
}

const EFFECTIVE = "status IN ('scheduled','swap')"

// 线性游戏时刻：游戏只在 9:00~18:00 推进，tick = (day-1)*10 + (hour-9)，全局唯一可比
function linear(day, hour) {
  return (day - 1) * HOURS_PER_DAY + (hour - OPEN_HOUR)
}

// ---------------- 基础查询 ----------------
export function listShiftTemplates({ activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM shift_templates WHERE active=1 ORDER BY sort,id'
    : 'SELECT * FROM shift_templates ORDER BY sort,id'
  return db.prepare(sql).all().map(sh => ({
    ...sh,
    begin_linear: linear(1, sh.start_hour),
    time_text: sh.cross_day
      ? `${sh.start_hour}:00 ~ 次日 ${String(sh.end_hour).padStart(2, '0')}:00`
      : `${sh.start_hour}:00 ~ ${sh.end_hour}:00`
  }))
}

function getShift(id) {
  return db.prepare('SELECT * FROM shift_templates WHERE id=? AND active=1').get(id)
}
function getStaff(id) {
  return db.prepare('SELECT * FROM staff WHERE id=?').get(id)
}
function effectiveScheduleOf(staffId, day) {
  return db.prepare(`SELECT * FROM staff_schedules WHERE staff_id=? AND day=? AND ${EFFECTIVE}`).get(staffId, day)
}
function attendanceBySchedule(scheduleId) {
  return db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(scheduleId)
}
function shiftBounds(sch, sh) {
  const begin = linear(sch.day, sh.start_hour)
  const end = sh.cross_day ? linear(sch.day + 1, sh.end_hour) : linear(sch.day, sh.end_hour)
  return { begin, end }
}
// 时薪按 5 小时基准班折算（早/中班干满≈日薪，晚班 4h 按比例，夜班含夜勤基准 6h）
function hourlyWage(wage) {
  return Math.max(20, Math.round(num(wage, 300) / 5))
}

function logShift({ scheduleId = null, attendanceId = null, requestId = null, planId = null, action, note = '', staffId = null, approverId = null }) {
  db.prepare('INSERT INTO shift_logs(schedule_id,attendance_id,request_id,tick,day,hour,action,note,staff_id,approver_id,plan_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(scheduleId, attendanceId, requestId, ctx.tick(), ctx.day(), ctx.hour(), action, note, staffId, approverId, planId)
}

// 跨日计划动作落时间线（plan_create/plan_approve/plan_reject/plan_item_apply/plan_item_skip）
function logPlan(planId, planCode, action, note, { staffId = null, approverId = null } = {}) {
  logShift({ planId, action, note: `【${planCode}】${note}`, staffId, approverId })
}

// ---------------- 幂等（复用 idempotency_keys，与预约模块同一套重放语义） ----------------
function idempotent(scope, requestId, fn) {
  const key = String(requestId || '').trim().slice(0, 80)
  if (!key) return fn()
  const hit = db.prepare('SELECT response FROM idempotency_keys WHERE scope=? AND key=?').get(scope, key)
  if (hit) return { ...JSON.parse(hit.response), replay: true }
  const result = fn()
  if (result?.code !== 'TX_FAILED') {
    db.prepare('INSERT OR IGNORE INTO idempotency_keys(scope,key,response,created_tick,created_day) VALUES(?,?,?,?,?)')
      .run(scope, key, JSON.stringify(result), ctx.tick(), ctx.day())
  }
  return result
}

const fail = (code, msg, extra = {}) => ({ ok: false, code, msg, ...extra })

// ---------------- 排班 ----------------
// 运营主管排班：校验员工在岗、班次有效、时间未过、同日冲突（DB 部分唯一索引兜底）
// source: manual 主管手排 / auto 基础自动补位 / dispatch 动态调度按缺口补位
// allowStarted：动态调度内部使用，允许补入刚开始的班段（引擎会在下一小时自动打卡；已结束仍拒绝）
export function createSchedule({ staffId, shiftId, day, note = '', source = 'manual', requestId = '', allowStarted = false }) {
  return idempotent('schedule_create', requestId, () => {
    try {
      return tx(() => {
        const st = getStaff(staffId)
        if (!st || !st.active) return fail('STAFF_OFF', '员工不存在或已离岗，无法排班')
        const sh = getShift(shiftId)
        if (!sh) return fail('SHIFT_NOT_FOUND', '班次不存在或已停用')
        day = Math.round(num(day))
        if (!Number.isInteger(day) || day < ctx.day()) return fail('DAY_PAST', '不能为已过去的游戏日排班')
        const t = ctx.tick()
        const begin = linear(day, sh.start_hour)
        const endB = sh.cross_day ? linear(day + 1, sh.end_hour) : linear(day, sh.end_hour)
        if (day === ctx.day() && begin <= t) {
          if (!allowStarted) return fail('SHIFT_STARTED', '该班次今日已开始，请选择尚未开始的班次')
          if (t >= endB) return fail('SHIFT_ENDED', '该班次已结束，无法补位')
        }
        const exist = effectiveScheduleOf(st.id, day)
        if (exist) return fail('SHIFT_CONFLICT', `${st.name} 当日已有排班，存在排班冲突`, { conflict_id: exist.id })

        const src = ['manual', 'auto', 'dispatch'].includes(source) ? source : 'manual'
        const ins = db.prepare(`INSERT INTO staff_schedules(staff_id,shift_id,day,status,source,create_tick,create_day,note)
                               VALUES(?,?,?, 'scheduled',?,?,?,?)`)
          .run(st.id, sh.id, day, src, ctx.tick(), ctx.day(),
            note || (src === 'auto' ? '系统基础自动排班' : src === 'dispatch' ? '动态调度按岗位缺口补位' : '运营主管排班'))
        const id = Number(ins.lastInsertRowid)
        const code = 'PB' + String(id).padStart(4, '0')
        db.prepare('UPDATE staff_schedules SET code=? WHERE id=?').run(code, id)
        logShift({
          scheduleId: id,
          action: src === 'dispatch' ? 'dispatch_fill' : src === 'auto' ? 'autofill' : 'schedule',
          note: `${st.name} 排入 ${sh.name}（${sh.cross_day ? `第${day}天 ` : ''}${sh.start_hour}:00${sh.cross_day ? ` ~ 次日 ${sh.end_hour}:00` : ` ~ ${sh.end_hour}:00`}）`,
          staffId: st.id
        })
        const warnings = coverageForDay(day).warnings
        return { ok: true, id, code, staff_id: st.id, day, shift_id: sh.id, source: src, warnings }
      })
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return fail('SHIFT_CONFLICT', '该员工当日已有排班，存在排班冲突')
      }
      console.error('[scheduling] 排班失败，已整体回滚:', e)
      return fail('TX_FAILED', '系统繁忙，本次排班未生效，请稍后重试')
    }
  })
}

// 取消排班：仅允许取消尚未打卡的排班（在岗离岗走离岗/解雇流程）
export function cancelSchedule(id, { requestId = '' } = {}) {
  return idempotent('schedule_cancel', requestId, () => {
    try {
      return tx(() => {
        const sch = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(id)
        if (!sch) return fail('NOT_FOUND', '排班不存在')
        if (sch.status === 'cancelled') return fail('SCHED_CANCELLED', '该排班已取消')
        const att = attendanceBySchedule(id)
        if (att && att.status === 'checked_in') return fail('ON_DUTY', '员工已打卡在岗，请先办理离岗')
        const sh = getShift(sch.shift_id)
        const { begin } = shiftBounds(sch, sh || { start_hour: OPEN_HOUR, end_hour: OPEN_HOUR, cross_day: 0 })
        if (begin <= ctx.tick() && !att) {
          // 班次已开始但未打卡（旷工窗口）：允许取消并按旷工留痕
          db.prepare("UPDATE staff_schedules SET status='cancelled' WHERE id=?").run(id)
          logShift({ scheduleId: id, action: 'cancel', note: '班次已开始未到岗，主管取消排班（按旷工处理）' })
          return { ok: true, absent: true }
        }
        db.prepare("UPDATE staff_schedules SET status='cancelled' WHERE id=?").run(id)
        // 关联待审批调班单一并作废
        db.prepare("UPDATE shift_requests SET status='cancelled', handle_tick=?, handle_note='排班被取消' WHERE schedule_id=? AND status='pending'")
          .run(ctx.tick(), id)
        logShift({ scheduleId: id, action: 'cancel', note: '运营主管取消排班' })
        return { ok: true }
      })
    } catch (e) {
      console.error('[scheduling] 取消排班失败，已整体回滚:', e)
      return fail('TX_FAILED', '系统繁忙，本次操作未生效，请稍后重试')
    }
  })
}

// ---------------- 考勤打卡 ----------------
// 引擎自动打卡；员工/前台也可在班次窗口内手动补打卡（晚于班次开始记迟到）
export function checkin(scheduleId, { requestId = '' } = {}) {
  return idempotent('schedule_checkin', requestId, () => {
    try {
      return tx(() => {
        const sch = db.prepare(`SELECT * FROM staff_schedules WHERE id=? AND ${EFFECTIVE}`).get(scheduleId)
        if (!sch) return fail('NOT_FOUND', '排班不存在或已取消')
        const st = getStaff(sch.staff_id)
        if (!st || !st.active) return fail('STAFF_OFF', '员工已离岗，无法打卡')
        if (attendanceBySchedule(sch.id)) return fail('ALREADY_CHECKIN', '该班次已打卡，请勿重复打卡')
        const sh = getShift(sch.shift_id)
        const { begin, end } = shiftBounds(sch, sh)
        const t = ctx.tick()
        if (t < begin) return fail('NOT_STARTED', '未到上班时间，暂不能打卡')
        if (t >= end) return fail('SHIFT_ENDED', '该班次已结束，无法补打卡')

        const late = t > begin ? 1 : 0
        const insAtt = db.prepare(`INSERT INTO staff_attendance(schedule_id,staff_id,day,shift_id,cross_day,checkin_tick,status,late)
                                   VALUES(?,?,?,?,?,?,'checked_in',?)`)
          .run(sch.id, st.id, sch.day, sh.id, sh.cross_day ? 1 : 0, t, late)
        const id = Number(insAtt.lastInsertRowid)
        const code = 'KQ' + String(id).padStart(4, '0')
        db.prepare('UPDATE staff_attendance SET code=? WHERE id=?').run(code, id)
        logShift({
          scheduleId: sch.id, attendanceId: id, action: 'checkin',
          note: `${st.name} ${late ? '迟到打卡上班' : '准时打卡上班'} · ${sh.name}`, staffId: st.id
        })
        if (late) logShift({ scheduleId: sch.id, attendanceId: id, action: 'late', note: `晚于班次开始 ${t - begin} 小时打卡`, staffId: st.id })
        return { ok: true, id, code, late: !!late }
      })
    } catch (e) {
      console.error('[scheduling] 打卡失败，已整体回滚:', e)
      return fail('TX_FAILED', '系统繁忙，本次打卡未生效，请稍后重试')
    }
  })
}

// ---------------- 工时结算 ----------------
// 下班/离岗结算：基准工时工资 + 已批加班 1.5 倍时薪；离岗按实际出勤比例折算，旷工无薪。
// 结算同时把本班累计满意度（完工回写 + 迟到 + 旷工 + 加班补贴）落到员工士气，工资逐条入财务流水。
// 跨日夜班在次日 9:00 下班时刻自动结算（settle_day=次日）。
function settleAttendance(att, status) {
  return tx(() => {
    const st = getStaff(att.staff_id)
    const sh = db.prepare('SELECT * FROM shift_templates WHERE id=?').get(att.shift_id)
    const sch = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(att.schedule_id)
    const t = ctx.tick()
    const bounds = sch && sh ? shiftBounds(sch, sh) : { begin: att.checkin_tick, end: att.checkin_tick + 5 }
    const workTicks = Math.max(att.work_ticks, status === 'checked_out' ? Math.max(0, t - att.checkin_tick) : att.work_ticks)
    const plannedTicks = Math.max(1, bounds.end - bounds.begin)
    const hourly = hourlyWage(st?.wage ?? 300)
    const otMul = num(getSetting('otRateMul'), 1.5)

    let pay = 0
    let noteKind = '下班打卡结算'
    if (status === 'checked_out') {
      const otPay = att.ot_approved ? Math.round(hourly * otMul * att.overtime_ticks) : 0
      pay = Math.round(hourly * (sh?.standard_hours ?? 5)) + otPay
      noteKind = '下班自动结算'
    } else if (status === 'leave') {
      const ratio = Math.max(0, Math.min(1, workTicks / plannedTicks))
      pay = Math.round(hourly * (sh?.standard_hours ?? 5) * ratio)
      noteKind = '中途离岗结算'
    } else if (status === 'absent') {
      pay = 0
      noteKind = '旷工无薪'
    }

    let moraleDelta = att.satisfaction_delta
    if (att.late) moraleDelta -= 1
    if (att.ot_approved && att.overtime_ticks > 0) moraleDelta += 1
    if (status === 'absent') moraleDelta -= 6
    if (status === 'leave') moraleDelta -= 2

    db.prepare(`UPDATE staff_attendance
       SET status=?, checkout_tick=?, work_ticks=?, pay=?, settle_day=?, satisfaction_delta=?
       WHERE id=?`)
      .run(status, t, workTicks, pay, ctx.day(), moraleDelta, att.id)
    if (st) {
      db.prepare('UPDATE staff SET morale=? WHERE id=?')
        .run(Math.max(20, Math.min(100, st.morale + moraleDelta)), st.id)
    }
    if (pay > 0 && ctx.logFinance) {
      setSetting('cash', Math.round(ctx.cash() - pay))
      const otText = att.ot_approved && att.overtime_ticks ? `（含加班 ${att.overtime_ticks}h ×${otMul}）` : ''
      ctx.logFinance(ctx.day(), '工资', -pay,
        `${noteKind} ${att.code} · ${st?.name || `员工#${att.staff_id}`} · ${sh?.name || ''} ${otText}`)
    }
    logShift({
      scheduleId: att.schedule_id, attendanceId: att.id, action: status === 'checked_out' ? 'checkout' : status,
      note: `${noteKind}：出勤 ${workTicks}h${att.late ? '（迟到）' : ''}，满意度 ${moraleDelta >= 0 ? '+' : ''}${moraleDelta}，工资 ¥${pay}`,
      staffId: att.staff_id
    })
    return { ok: true, pay, workTicks, moraleDelta }
  })
}

// 旷工留痕（未打卡且班次结束）
function markAbsent(sch, sh) {
  const st = getStaff(sch.staff_id)
  const insAbs = db.prepare(`INSERT INTO staff_attendance(schedule_id,staff_id,day,shift_id,cross_day,checkin_tick,checkout_tick,work_ticks,status)
                             VALUES(?,?,?,?,?,0,?,0,'absent')`)
    .run(sch.id, sch.staff_id, sch.day, sch.shift_id, sh.cross_day ? 1 : 0, ctx.tick())
  const id = Number(insAbs.lastInsertRowid)
  const code = 'KQ' + String(id).padStart(4, '0')
  db.prepare('UPDATE staff_attendance SET code=?, settle_day=? WHERE id=?').run(code, ctx.day(), id)
  logShift({
    scheduleId: sch.id, attendanceId: id, action: 'absent',
    note: `${st?.name || '员工'} 未打卡上班，班次结束按旷工处理（无薪，满意度 -6）`, staffId: sch.staff_id
  })
  settleAttendance(db.prepare('SELECT * FROM staff_attendance WHERE id=?').get(id), 'absent')
}

// 员工中途离岗（非解雇）：当前考勤立即按实际工时折算结算
export function leavePost(attendanceId, { reason = '', requestId = '' } = {}) {
  return idempotent('schedule_leave', requestId, () => {
    try {
      const att = db.prepare("SELECT * FROM staff_attendance WHERE id=? AND status='checked_in'").get(attendanceId)
      if (!att) return fail('NOT_ON_DUTY', '考勤单不存在或已不在岗')
      const r = tx(() => {
        const out = settleAttendance(att, 'leave')
        db.prepare('UPDATE staff_attendance SET note=? WHERE id=?').run(`中途离岗：${String(reason).slice(0, 80) || '个人原因'}`, att.id)
        return out
      })
      return r
    } catch (e) {
      console.error('[scheduling] 离岗结算失败:', e)
      return fail('TX_FAILED', '系统繁忙，离岗未生效，请稍后重试')
    }
  })
}

// 解雇/离岗接续：未来排班全部取消、待审批调班单作废；在岗考勤立即离岗结算
export function releaseStaffSchedules(staffId) {
  return tx(() => {
    const t = ctx.tick()
    // 在岗考勤 → 立即离岗结算
    const onDuty = db.prepare("SELECT * FROM staff_attendance WHERE staff_id=? AND status='checked_in'").all(staffId)
    for (const att of onDuty) settleAttendance(att, 'leave')
    // 有效排班（含调班中）一律取消
    const scheds = db.prepare(`SELECT * FROM staff_schedules WHERE staff_id=? AND ${EFFECTIVE}`).all(staffId)
    for (const sch of scheds) {
      const att = attendanceBySchedule(sch.id)
      if (att && (att.status === 'checked_out' || att.status === 'absent')) continue
      db.prepare("UPDATE staff_schedules SET status='cancelled' WHERE id=?").run(sch.id)
      logShift({ scheduleId: sch.id, action: 'cancel', note: '员工离岗，未执行排班自动取消', staffId })
    }
    // 本人发起的待审批申请 → 取消；本人作为调班目标的申请 → 取消并还原原排班
    const reqs = db.prepare("SELECT * FROM shift_requests WHERE status='pending' AND (staff_id=? OR target_staff_id=?)").all(staffId, staffId)
    for (const rq of reqs) {
      db.prepare("UPDATE shift_requests SET status='cancelled', handle_tick=?, handle_note='相关员工离岗，申请自动作废' WHERE id=?").run(t, rq.id)
      if (rq.kind === 'swap' && rq.target_staff_id === staffId && rq.schedule_id) {
        db.prepare("UPDATE staff_schedules SET status='scheduled' WHERE id=? AND status='swap'").run(rq.schedule_id)
      }
      logShift({ requestId: rq.id, action: rq.kind === 'swap' ? 'swap_reject' : 'ot_reject', note: '相关员工离岗，申请自动作废' })
    }
    return { schedules: scheds.length, onDuty: onDuty.length }
  })
}

// ---------------- 调班 / 加班协作 ----------------
// 员工发起调班：仅未开始的排班可调；目标同事同日不得已有排班（硬冲突拦截，覆盖缺口仅预警）
export function requestSwap({ staffId, scheduleId, targetStaffId, targetShiftId, targetDay, reason = '', requestId = '' }) {
  return idempotent('swap_request', requestId, () => {
    try {
      return tx(() => {
        const sch = db.prepare(`SELECT * FROM staff_schedules WHERE id=? AND ${EFFECTIVE}`).get(scheduleId)
        if (!sch) return fail('NOT_FOUND', '排班不存在或已取消')
        if (sch.staff_id !== staffId) return fail('NOT_OWN', '只能申请调整本人的排班')
        const st = getStaff(staffId)
        const target = getStaff(targetStaffId)
        if (!target || !target.active) return fail('STAFF_OFF', '代班同事不存在或已离岗')
        if (target.id === staffId) return fail('BAD_TARGET', '不能与本人调班')
        const sh = getShift(targetShiftId)
        if (!sh) return fail('SHIFT_NOT_FOUND', '目标班次不存在或已停用')
        targetDay = Math.round(num(targetDay, sch.day))
        if (targetDay < ctx.day()) return fail('DAY_PAST', '目标日期已过')
        const t = ctx.tick()
        const { begin: srcBegin } = shiftBounds(sch, getShift(sch.shift_id))
        if (srcBegin <= t) return fail('SHIFT_STARTED', '本班次已开始，不能调班')
        const targetBegin = linear(targetDay, sh.start_hour)
        if (targetDay === ctx.day() && targetBegin <= t) return fail('SHIFT_STARTED', '目标班次今日已开始')
        if (effectiveScheduleOf(target.id, targetDay)) return fail('SHIFT_CONFLICT', `${target.name} 目标日已有排班，存在冲突`)
        const dup = db.prepare("SELECT id FROM shift_requests WHERE kind='swap' AND status='pending' AND schedule_id=?").get(scheduleId)
        if (dup) return fail('REQUEST_PENDING', '该排班已有待审批的调班申请')

        const insReq = db.prepare(`INSERT INTO shift_requests(kind,staff_id,schedule_id,day,target_staff_id,target_shift_id,target_day,reason,status,create_tick,create_day)
                                  VALUES('swap',?,?,?,?,?,?,?,'pending',?,?)`)
          .run(staffId, sch.id, sch.day, target.id, sh.id, targetDay, String(reason).slice(0, 120), t, ctx.day())
        const id = Number(insReq.lastInsertRowid)
        const code = 'TB' + String(id).padStart(4, '0')
        db.prepare('UPDATE shift_requests SET code=? WHERE id=?').run(code, id)
        db.prepare("UPDATE staff_schedules SET status='swap' WHERE id=?").run(sch.id)
        logShift({
          scheduleId: sch.id, requestId: id, action: 'swap_request',
          note: `${st?.name} 申请与 ${target.name} 调班至第 ${targetDay} 天 ${sh.name}${reason ? `：${reason}` : ''}`, staffId
        })
        return { ok: true, id, code, warnings: coverageForDay(sch.day).warnings }
      })
    } catch (e) {
      console.error('[scheduling] 调班申请失败，已整体回滚:', e)
      return fail('TX_FAILED', '系统繁忙，申请未提交，请稍后重试')
    }
  })
}

// 运营主管审批调班：原子完成「原排班取消 + 代班人新排班」，任一步失败整体回滚；
// 提交后触发动态调度补齐调班留下的覆盖缺口
export function approveSwap(requestId, approverId) {
  let result
  try {
    result = tx(() => {
      const rq = db.prepare("SELECT * FROM shift_requests WHERE id=? AND kind='swap' AND status='pending'").get(requestId)
      if (!rq) return fail('REQUEST_GONE', '调班申请不存在或已处理')
      const src = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(rq.schedule_id)
      const from = getStaff(rq.staff_id)
      const target = getStaff(rq.target_staff_id)
      const sh = getShift(rq.target_shift_id)
      if (!src || src.status !== 'swap') return fail('SCHED_GONE', '原排班状态已变化，无法调班')
      if (!from?.active || !target?.active || !sh) return fail('STAFF_OFF', '相关员工已离岗或班次已停用')
      if (effectiveScheduleOf(target.id, rq.target_day)) return fail('SHIFT_CONFLICT', `${target.name} 目标日已有排班，调班冲突`)
      const t = ctx.tick()
      const targetBegin = linear(rq.target_day, sh.start_hour)
      if (targetBegin <= t) return fail('SHIFT_STARTED', '目标班次已开始，不能再调班')

      // 原排班取消（不会产生考勤，尚无打卡）
      db.prepare("UPDATE staff_schedules SET status='cancelled', note=? WHERE id=?")
        .run(`调班转出 → ${target.name}（${rq.code}）`, src.id)
      const insNs = db.prepare(`INSERT INTO staff_schedules(staff_id,shift_id,day,status,source,create_tick,create_day,note)
                               VALUES(?,?,?,'scheduled','swap',?,?,?)`)
        .run(target.id, sh.id, rq.target_day, t, ctx.day(), `调班接替 ${from.name}（${rq.code}）`)
      const ns = Number(insNs.lastInsertRowid)
      const nsCode = 'PB' + String(ns).padStart(4, '0')
      db.prepare('UPDATE staff_schedules SET code=? WHERE id=?').run(nsCode, ns)
      db.prepare("UPDATE shift_requests SET status='approved', approver_id=?, handle_tick=?, handle_note='主管批准调班' WHERE id=?")
        .run(approverId, t, rq.id)
      logShift({ scheduleId: src.id, requestId: rq.id, action: 'swap_approve', note: `调班批准：${from.name} → ${target.name}（第 ${rq.target_day} 天 ${sh.name}）`, approverId })
      logShift({ scheduleId: ns, requestId: rq.id, action: 'schedule', note: `${target.name} 调班接替排班`, staffId: target.id })
      return { ok: true, new_schedule_id: ns, affectedDays: [src.day, rq.target_day] }
    })
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return fail('SHIFT_CONFLICT', '代班人目标日已有排班，调班冲突')
    console.error('[scheduling] 调班审批失败，已整体回滚:', e)
    return fail('TX_FAILED', '系统繁忙，审批未生效，请稍后重试')
  }
  // 审批提交后再联动动态补位（补位失败不影响审批结果）
  if (result?.ok) {
    const days = result.affectedDays || []
    const auto = num(getSetting('scheduleAutoFill'), 1) && getSetting('scheduleMode', 'dynamic') === 'dynamic'
    if (auto) {
      result.dispatch = num(getSetting('schedulePlanApproval'), 0)
        ? autoMaintainPlan('调班审批后跨日计划补缺')
        : runDynamicDispatch({ horizon: 3, urgentOvertime: true, reason: '调班审批后覆盖缺口补齐' })
    }
    result.warnings = coverageForDay(days[days.length - 1] || ctx.day()).warnings
  }
  return result
}

// 驳回调班：原排班恢复
export function rejectSwap(requestId, approverId, note = '主管驳回调班') {
  return tx(() => {
    const rq = db.prepare("SELECT * FROM shift_requests WHERE id=? AND kind='swap' AND status='pending'").get(requestId)
    if (!rq) return fail('REQUEST_GONE', '调班申请不存在或已处理')
    db.prepare("UPDATE shift_requests SET status='rejected', approver_id=?, handle_tick=?, handle_note=? WHERE id=?")
      .run(approverId, ctx.tick(), String(note).slice(0, 80), rq.id)
    db.prepare("UPDATE staff_schedules SET status='scheduled' WHERE id=? AND status='swap'").run(rq.schedule_id)
    logShift({ scheduleId: rq.schedule_id, requestId: rq.id, action: 'swap_reject', note, approverId })
    return { ok: true }
  })
}

// 员工加班申请：仅当值考勤可申请；日班下班+加班不晚于 18:00，跨日夜班不晚于次日 12:00
export function requestOvertime({ staffId, scheduleId, ticks, reason = '', requestId = '' }) {
  return idempotent('ot_request', requestId, () => {
    try {
      return tx(() => {
        ticks = Math.round(num(ticks))
        if (!Number.isInteger(ticks) || ticks < 1 || ticks > 4) return fail('BAD_OT', '加班时长需为 1~4 小时')
        const sch = db.prepare(`SELECT * FROM staff_schedules WHERE id=? AND ${EFFECTIVE}`).get(scheduleId)
        if (!sch || sch.staff_id !== staffId) return fail('NOT_FOUND', '排班不存在或不属于本人')
        const att = attendanceBySchedule(sch.id)
        if (!att || att.status !== 'checked_in') return fail('NOT_ON_DUTY', '仅当值员工可申请加班，请先打卡上班')
        const sh = getShift(sch.shift_id)
        const maxEnd = sh.cross_day ? 12 : CLOSE_HOUR
        const curEnd = sh.end_hour + att.overtime_ticks
        if (curEnd + ticks > maxEnd) return fail('OT_TOO_LONG', `加班后下班不得晚于${sh.cross_day ? '次日 ' : ''}${maxEnd}:00`)
        const dup = db.prepare("SELECT id FROM shift_requests WHERE kind='overtime' AND status='pending' AND schedule_id=?").get(sch.id)
        if (dup) return fail('REQUEST_PENDING', '该班次已有待审批的加班申请')

        const insOt = db.prepare(`INSERT INTO shift_requests(kind,staff_id,schedule_id,day,ot_ticks,reason,status,create_tick,create_day)
                                 VALUES('overtime',?,?,?,?,?,'pending',?,?)`)
          .run(staffId, sch.id, sch.day, ticks, String(reason).slice(0, 120), ctx.tick(), ctx.day())
        const id = Number(insOt.lastInsertRowid)
        const code = 'TB' + String(id).padStart(4, '0')
        db.prepare('UPDATE shift_requests SET code=? WHERE id=?').run(code, id)
        logShift({
          scheduleId: sch.id, attendanceId: att.id, requestId: id, action: 'ot_request',
          note: `申请加班 ${ticks}h${reason ? `：${reason}` : ''}（${sh.name}延后下班）`, staffId
        })
        return { ok: true, id, code }
      })
    } catch (e) {
      console.error('[scheduling] 加班申请失败，已整体回滚:', e)
      return fail('TX_FAILED', '系统繁忙，申请未提交，请稍后重试')
    }
  })
}

// 主管批准加班：写入考勤，下班点顺延，按 1.5 倍时薪结算
export function approveOvertime(requestId, approverId) {
  return tx(() => {
    const rq = db.prepare("SELECT * FROM shift_requests WHERE id=? AND kind='overtime' AND status='pending'").get(requestId)
    if (!rq) return fail('REQUEST_GONE', '加班申请不存在或已处理')
    const att = db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(rq.schedule_id)
    if (!att || att.status !== 'checked_in') return fail('NOT_ON_DUTY', '员工已不在岗，加班申请自动失效')
    const sh = getShift(att.shift_id)
    const maxEnd = sh.cross_day ? 12 : CLOSE_HOUR
    if (sh.end_hour + att.overtime_ticks + rq.ot_ticks > maxEnd) return fail('OT_TOO_LONG', '加班后下班超出营业时段限制')
    db.prepare('UPDATE staff_attendance SET ot_approved=1, overtime_ticks=overtime_ticks+? WHERE id=?').run(rq.ot_ticks, att.id)
    db.prepare("UPDATE shift_requests SET status='approved', approver_id=?, handle_tick=?, handle_note='主管批准加班' WHERE id=?")
      .run(approverId, ctx.tick(), rq.id)
    logShift({
      scheduleId: rq.schedule_id, attendanceId: att.id, requestId: rq.id, action: 'ot_approve',
      note: `批准加班 ${rq.ot_ticks}h（1.5 倍时薪），下班顺延至 ${sh.cross_day ? '次日 ' : ''}${sh.end_hour + att.overtime_ticks + rq.ot_ticks}:00`, approverId
    })
    return { ok: true, overtime_ticks: att.overtime_ticks + rq.ot_ticks }
  })
}

export function rejectOvertime(requestId, approverId, note = '主管驳回加班') {
  return tx(() => {
    const rq = db.prepare("SELECT * FROM shift_requests WHERE id=? AND kind='overtime' AND status='pending'").get(requestId)
    if (!rq) return fail('REQUEST_GONE', '加班申请不存在或已处理')
    db.prepare("UPDATE shift_requests SET status='rejected', approver_id=?, handle_tick=?, handle_note=? WHERE id=?")
      .run(approverId, ctx.tick(), String(note).slice(0, 80), rq.id)
    logShift({ scheduleId: rq.schedule_id, requestId: rq.id, action: 'ot_reject', note, approverId })
    return { ok: true }
  })
}

// 员工撤回本人待审批申请
export function cancelRequest(requestId, staffId) {
  return tx(() => {
    const rq = db.prepare("SELECT * FROM shift_requests WHERE id=? AND status='pending' AND staff_id=?").get(requestId, staffId)
    if (!rq) return fail('REQUEST_GONE', '申请不存在、已处理或非本人申请')
    db.prepare("UPDATE shift_requests SET status='cancelled', handle_tick=?, handle_note='员工撤回' WHERE id=?").run(ctx.tick(), rq.id)
    if (rq.kind === 'swap') db.prepare("UPDATE staff_schedules SET status='scheduled' WHERE id=? AND status='swap'").run(rq.schedule_id)
    logShift({ requestId: rq.id, scheduleId: rq.schedule_id, action: rq.kind === 'swap' ? 'swap_reject' : 'ot_reject', note: '员工撤回申请', staffId })
    return { ok: true }
  })
}

// ---------------- 需求画像（预约客流 / 检修工单 / 投诉岗位 → 班段×岗位需求） ----------------
// 班段 → 班次：早班/中班/晚班/跨日夜班；映射定义统一来自 flow.js（闭环唯一事实源）
const BANDS = FLOW_BANDS
const GUARD_ROLE_SET_LOCAL = GUARD_ROLE_SET
const ROLE_GROUP = { guard: GUARD_ROLE_SET_LOCAL, clean: ['保洁'], repair: ['维修'] }
// 缺口对象中的角色名 → 角色数组
const ROLES_BY_NAME = { '保安/安保': GUARD_ROLE_SET_LOCAL, '保洁': ['保洁'], '维修工': ['维修'] }

// 某日需求画像：班段 × 岗位（保安/保洁/维修）需求人数与依据
export function demandForDay(day) {
  day = Math.round(num(day))
  const walkMap = avgWalkinByHour()
  // 统一客流预测（散客/团队/会员预约 + 设施折算 + 散客自适应外推），与闭环看板同一事实源
  const hours = hourlyForecast(day, walkMap)
  const openZones = db.prepare('SELECT id,name FROM zones WHERE open=1 AND unlocked=1 ORDER BY id').all()
  const zoneN = openZones.length
  const guardFlowPer = Math.max(100, num(getSetting('dispatchGuardFlow'), 500))
  const cleanFlowPer = Math.max(100, num(getSetting('dispatchCleanFlow'), 700))

  const bands = BANDS.map(b => {
    const hs = hours.filter(h => b.hours.includes(h.hour))
    const flow = hs.reduce((s, h) => s + h.flow, 0)
    const peak = hs.reduce((m, h) => Math.max(m, h.flow), 0)
    return {
      key: b.key, label: b.label, shift_code: b.shift_code, hours: b.hours,
      flow, peak,
      reserveEntry: hs.reduce((s, h) => s + h.entry, 0),
      groupEntry: hs.reduce((s, h) => s + h.groupEntry, 0),
      walkin: hs.reduce((s, h) => s + h.walkin, 0),
      // 客流驱动：每满一个承载阈值增配 1 人；至少保障每个班段有人（区域基线另行全日校验）
      need_guard: Math.max(zoneN ? 1 : 0, Math.ceil(peak / guardFlowPer)),
      need_clean: Math.max(zoneN ? 1 : 0, Math.ceil(flow / cleanFlowPer)),
      need_repair: 0,
      orders: [],
      complaints: []
    }
  })
  const bandOf = k => bands.find(x => x.key === k)

  // 检修工单需求：每个在途工单需 1 名维修工；按统一优先级排序（检修中 > 排队、进度低更紧急），
  // 高优先工单优先占早班接单/推进，其余摊到早/中班
  const orders = db.prepare(`SELECT mo.id, mo.code, mo.status, mo.progress, r.name ride_name, r.zone_id
                             FROM maintenance_orders mo JOIN rides r ON r.id=mo.ride_id
                             WHERE mo.status IN ('queued','processing')`).all()
    .map(o => ({ ...o, priority: maintenancePriority(o) }))
    .sort((a, b2) => b2.priority - a.priority)
  for (const o of orders) {
    const target = o.status === 'processing' ? (bandOf('mid').need_repair <= bandOf('morning').need_repair ? 'mid' : 'morning') : 'morning'
    bandOf(target).need_repair += 1
    bandOf(target).orders.push({ id: o.id, code: o.code, status: o.status, ride_name: o.ride_name, progress: o.progress, zone_id: o.zone_id, priority: o.priority })
  }

  // 投诉岗位需求：统一优先级评分（严重度 × SLA 剩余时限 × 升级记录）排序后摊入班段；
  // 紧急投诉强制早班，其余按优先级轮摊早/中/晚，保证最紧急的投诉最先占人
  const compBands = ['morning', 'mid', 'evening']
  const complaints = db.prepare("SELECT * FROM complaints WHERE status IN ('open','processing','ready') ORDER BY id DESC LIMIT 60").all()
    .map(c => ({ ...c, priority: complaintPriority(c) }))
    .filter(c => (ctx.complaintRoles?.[c.category] || []).filter(Boolean).length)
    .sort((a, b2) => b2.priority - a.priority)
  let compCursor = 0
  for (const c of complaints) {
    const roles = (ctx.complaintRoles?.[c.category] || []).filter(Boolean)
    const key = c.severity === 3 ? 'morning' : compBands[compCursor++ % compBands.length]
    bandOf(key).complaints.push({ id: c.id, code: c.code, category: c.category, severity: c.severity, status: c.status, roles, priority: c.priority, deadline_tick: c.deadline_tick })
  }
  for (const b of bands) {
    b.complaints.sort((a, b2) => b2.priority - a.priority)
    const byRole = { guard: 0, clean: 0, repair: 0 }
    for (const c of b.complaints) {
      const g = c.roles.some(r => GUARD_ROLE_SET_LOCAL.includes(r)) ? 'guard' : c.roles.includes('保洁') ? 'clean' : 'repair'
      byRole[g] += 1
    }
    b.need_guard = Math.max(b.need_guard, byRole.guard > 0 ? 1 : 0)
    b.need_clean = Math.max(b.need_clean, byRole.clean > 0 ? 1 : 0)
    b.need_repair = b.need_repair + (byRole.repair > 0 ? 1 : 0)
  }

  // 跨日夜班需求：每 N 个开放区域至少 1 名夜勤保安（默认 N=0 不强制，运营可调）；
  // 同时按闭园前（17:00）统一预测客流兜底——预测大客流收尾/夜间清场需要夜勤保安接续
  const nightPerZone = Math.max(0, num(getSetting('dispatchNightGuardsPerZone'), 0))
  const hour17 = hours.find(h => h.hour === 17)
  const nightByFlow = hour17 && hour17.flow > 0 ? Math.ceil(hour17.flow / (guardFlowPer * 2)) : 0
  bandOf('night').need_guard = Math.max(nightPerZone > 0 ? Math.ceil(zoneN / nightPerZone) : 0, nightByFlow)
  bandOf('night').need_clean = 0
  bandOf('night').need_repair = 0

  return {
    day,
    isToday: day === ctx.day(),
    zones: openZones,
    hours,
    bands,
    flowTotal: hours.reduce((s, h) => s + h.flow, 0),
    reserveTotal: hours.reduce((s, h) => s + h.entry, 0),
    groupTotal: hours.reduce((s, h) => s + h.groupEntry, 0),
    walkinTotal: hours.reduce((s, h) => s + h.walkin, 0),
    openOrders: orders.length,
    openComplaints: complaints.length
  }
}

// ---------------- 岗位覆盖校验（需求驱动：班段 × 岗位 需/在岗对比 + 跨日夜班） ----------------
const GUARD_ROLES = GUARD_ROLE_SET_LOCAL
// 某日有效排班对应的在岗员工集合（含前一日跨日夜班在当日早晨仍在岗的人员）。
// extras：跨日计划草案中的「虚拟排班」（dry-run 时与真实排班并列为候选/缺口计算依据），
// 字段为 staff_id/shift_id/day 与跨日属性。
function roster(day, extras = []) {
  const list = db.prepare(`
    SELECT s.*, sc.id schedule_id, sc.day sched_day, sc.status sched_status, sc.source sched_source,
           sh.id shift_id, sh.code shift_code, sh.name shift_name,
           sh.start_hour, sh.end_hour, sh.cross_day, sh.color, sh.standard_hours,
           a.id att_id, a.status att_status, a.overtime_ticks, a.late
    FROM staff_schedules sc
    JOIN staff s ON s.id=sc.staff_id
    JOIN shift_templates sh ON sh.id=sc.shift_id
    LEFT JOIN staff_attendance a ON a.schedule_id=sc.id
    WHERE sc.${EFFECTIVE} AND s.active=1
      AND (sc.day=? OR (sh.cross_day=1 AND sc.day=?))`).all(day, day - 1)
  const shiftCache = new Map()
  const staffCache = new Map()
  for (const e of extras) {
    if (!shiftCache.has(e.shift_id)) shiftCache.set(e.shift_id, getShift(e.shift_id))
    const sh2 = shiftCache.get(e.shift_id)
    if (!sh2) continue
    if (!staffCache.has(e.staff_id)) staffCache.set(e.staff_id, getStaff(e.staff_id))
    const st2 = staffCache.get(e.staff_id)
    if (!st2) continue
    if (e.day !== day && !(sh2.cross_day && e.day === day - 1)) continue
    list.push({
      id: st2.id, name: st2.name, role: st2.role, zone_id: st2.zone_id, wage: st2.wage, skill: st2.skill,
      schedule_id: e.virtual_id ? -e.virtual_id : -(e.staff_id * 1000 + e.day), virtual: 1,
      day: e.day, sched_day: e.day, sched_status: 'scheduled', sched_source: 'plan',
      shift_id: sh2.id, shift_code: sh2.code, shift_name: sh2.name,
      start_hour: sh2.start_hour, end_hour: sh2.end_hour, cross_day: sh2.cross_day,
      color: sh2.color, standard_hours: sh2.standard_hours,
      att_id: null, att_status: '', overtime_ticks: e.virtual_ot || 0, late: 0
    })
  }
  const t = ctx.tick()
  return list.map(s => {
    const begin = linear(s.sched_day, s.start_hour)
    const end = (s.cross_day ? linear(s.sched_day + 1, s.end_hour) : linear(s.sched_day, s.end_hour)) + (s.overtime_ticks || 0)
    return { ...s, begin_linear: begin, end_linear: end, on_duty_now: s.att_status === 'checked_in' && t >= begin && t < end }
  })
}

// 班段内某岗位在岗/已排人数；当天按真实考勤时段统计，未来/过去日按排班统计
function countByBand(list, day, bandKey, roleCheck) {
  const band = BANDS.find(b => b.key === bandKey)
  const t = ctx.tick()
  return list.filter(s => {
    if (!roleCheck(s.role)) return false
    if (s.cross_day) {
      // 跨日夜班只计入其上班日的晚班 17 点与夜班；前一日夜班在当日 9 点结束，不计入当日早班
      return day === s.sched_day && (bandKey === 'night' || (bandKey === 'evening' && band.hours.includes(17)))
    }
    if (s.sched_day !== day) return false
    if (day === ctx.day()) {
      // 当天：已下班/旷工/离岗不计当前在岗，未开始班次按"将到岗"统计（供未来小时预警区分）
      if (band.hours.some(h => linear(day, h) <= t)) {
        return !!s.on_duty_now && band.hours.some(h => { const l = linear(day, h); return l >= s.begin_linear && l < s.end_linear })
      }
      return band.shift_code === s.shift_code
    }
    return band.shift_code === s.shift_code
  }).length
}

// 排班/调班后校验当日岗位覆盖：客流/检修/投诉需求与班段在岗对比，给出量化缺口预警
// - warn：未来班段/未来日缺口，可由动态调度自动补位或主管调班补齐；
// - block：当天班段已经开始且在岗不足（检修中工单/紧急投诉无匹配岗位时升级为 block）
export function coverageForDay(day) {
  day = Math.round(num(day))
  const warnings = []
  const list = roster(day)
  const push = (type, level, msg, extra = {}) => warnings.push({ type, level, msg, ...extra })
  const isToday = day === ctx.day()
  const t = ctx.tick()
  const bandStarted = b => isToday && b.hours.some(h => linear(day, h) <= t)

  // 1) 区域全日基线：每个开放区域需有保安/安保与保洁（按员工归属区域）
  const zones = db.prepare('SELECT * FROM zones WHERE open=1 AND unlocked=1 ORDER BY id').all()
  for (const z of zones) {
    const here = list.filter(s => s.zone_id === z.id && !s.cross_day && s.sched_day === day)
    if (!here.some(s => GUARD_ROLES.includes(s.role))) push('zone_guard', 'warn', `「${z.name}」全日无保安/安保排班，秩序岗位缺岗`, { zone: z.name })
    if (!here.some(s => s.role === '保洁')) push('zone_clean', 'warn', `「${z.name}」全日无保洁排班，卫生岗位缺岗`, { zone: z.name })
  }

  // 2) 需求画像 → 班段 × 岗位缺口
  const demand = demandForDay(day)
  const checks = [
    { key: 'need_guard', type: 'flow_guard', roles: GUARD_ROLES, roleName: '保安/安保' },
    { key: 'need_clean', type: 'flow_clean', roles: ['保洁'], roleName: '保洁' },
    { key: 'need_repair', type: 'maintenance_band', roles: ['维修'], roleName: '维修工' }
  ]
  for (const b of demand.bands) {
    for (const c of checks) {
      const need = b[c.key]
      if (!need) continue
      const have = countByBand(list, day, b.key, r => c.roles.includes(r))
      if (have >= need) continue
      const started = bandStarted(b)
      let level = started ? 'warn' : 'warn'
      let reason = ''
      if (c.key === 'need_repair') {
        const proc = (b.orders || []).some(o => o.status === 'processing')
        level = started && proc ? 'block' : 'warn'
        reason = `检修工单 ${(b.orders || []).map(o => o.code).join('、')} 需要 ${c.roleName}`
      } else {
        reason = `${b.label}预测客流峰值 ${b.peak} 人`
      }
      push(c.type, level, `${b.label}（${b.hours[0]}:00~${b.key === 'evening' ? 18 : b.hours[b.hours.length - 1] + 1}:00）${c.roleName}需求 ${need} 人、在岗 ${have} 人，缺口 ${need - have} 人：${reason}`,
        { band: b.key, role: c.roleName, need, have, gap: need - have })
    }
    // 投诉岗位缺口（按班段挂载的投诉逐条提示，紧急投诉且班段已开始 → block）
    for (const c of b.complaints) {
      const roles = c.roles
      const roleCheck = r => roles.some(x => GUARD_ROLES.includes(x) ? GUARD_ROLES.includes(r) : r === x)
      const have = countByBand(list, day, b.key, roleCheck)
      if (have > 0) continue
      const level = bandStarted(b) && c.severity === 3 ? 'block' : 'warn'
      push('complaint', level,
        `${b.label}投诉 ${c.code}（${c.severity === 3 ? '紧急' : c.severity === 2 ? '严重' : '一般'}）需「${roles.join('/')}」岗位，当前缺口 1 人`,
        { band: b.key, complaint_id: c.id, complaint_code: c.code, severity: c.severity, need: 1, have: 0, gap: 1 })
    }
  }

  // 3) 在途检修工单兜底（无任何维修工排班 → 沿用旧版强提示）
  const allOrders = db.prepare("SELECT mo.*, r.name ride_name FROM maintenance_orders mo JOIN rides r ON r.id=mo.ride_id WHERE mo.status IN ('queued','processing')").all()
  for (const o of allOrders) {
    const covered = list.some(s => s.role === '维修' && !s.cross_day && s.sched_day === day)
    if (!covered) {
      push('maintenance', o.status === 'processing' ? 'block' : 'warn',
        `检修工单 ${o.code}（${o.ride_name}）${o.status === 'processing' ? '检修中' : '排队中'}，当日无维修工当班`,
        { order_id: o.id, order_code: o.code, ride_name: o.ride_name })
    }
  }

  return { day, warnings, rosterCount: list.length, demand }
}

// ---------------- 动态调度：按需求缺口自动补位 + 紧急加班调令 ----------------
// 疲劳规避：前一日上跨日夜班（次日 9 点才下班）的员工，当日日班不再排；
// nightExtras 为计划草案中虚拟的前夜夜班（dry-run 时同样规避）
function workedNightBefore(staffId, day, nightExtras = []) {
  if (nightExtras.some(e => e.staff_id === staffId && e.day === day - 1)) return true
  return !!db.prepare(`
    SELECT 1 FROM staff_schedules sc
    JOIN shift_templates sh ON sh.id=sc.shift_id
    WHERE sc.staff_id=? AND sc.day=? AND sh.cross_day=1 AND sc.${EFFECTIVE}`).get(staffId, day - 1)
}

// 候选员工：在岗、非运营主管、当日无有效排班、非前夜夜班；按区域匹配与既有排班负载排序。
// dayExtras/nightExtras：计划草案虚拟排班（当日已拟排 / 前夜拟排夜班），dry-run 时参与去重与疲劳规避。
function dispatchCandidates(day, roles, zoneId = null, dayExtras = [], nightExtras = []) {
  const busyVirtual = new Set(dayExtras.filter(e => e.day === day).map(e => e.staff_id))
  return db.prepare("SELECT * FROM staff WHERE active=1 AND role<>'运营主管' ORDER BY id").all()
    .filter(st => roles.includes(st.role))
    .filter(st => !effectiveScheduleOf(st.id, day))
    .filter(st => !busyVirtual.has(st.id))
    .filter(st => !workedNightBefore(st.id, day, nightExtras))
    .sort((a, b) => {
      const za = zoneId ? (a.zone_id === zoneId ? 0 : 1) : 0
      const zb = zoneId ? (b.zone_id === zoneId ? 0 : 1) : 0
      if (za !== zb) return za - zb
      const loadA = db.prepare(`SELECT COUNT(*) n FROM staff_schedules WHERE staff_id=? AND day BETWEEN ? AND ? AND ${EFFECTIVE}`).get(a.id, day, day + 2).n
        + dayExtras.filter(e => e.staff_id === a.id && e.day >= day && e.day <= day + 2).length
      const loadB = db.prepare(`SELECT COUNT(*) n FROM staff_schedules WHERE staff_id=? AND day BETWEEN ? AND ? AND ${EFFECTIVE}`).get(b.id, day, day + 2).n
        + dayExtras.filter(e => e.staff_id === b.id && e.day >= day && e.day <= day + 2).length
      return loadA - loadB || b.skill - a.skill
    })
}

// 计算某日班段 × 岗位缺口（直接以需求画像为事实源，避免从预警文案反推）
// 动态调度视角：当天班段进行中时，已排进本班段但尚未打卡的人也计入（引擎到点自动打卡/稍后补打卡）
// extras：计划草案虚拟排班（dry-run 预览/审批时，与真实排班并列计入在岗覆盖）
export function gapsForDay(day, { forDispatch = true, extras = [], demand = null } = {}) {
  demand = demand || demandForDay(day)
  const list = roster(day, extras)
  const t = ctx.tick()
  const countRole = (bandKey, roles) => list.filter(s => {
    if (!roles.includes(s.role)) return false
    const band = BANDS.find(b => b.key === bandKey)
    if (s.cross_day) {
      return day === s.sched_day && (bandKey === 'night' || (bandKey === 'evening' && band.hours.includes(17)))
    }
    if (s.sched_day !== day) return false
    if (band.shift_code !== s.shift_code) return false
    if (forDispatch && day === ctx.day()) {
      const curHour = OPEN_HOUR + (t - linear(day, OPEN_HOUR))
      const inBand = band.hours.some(h => h <= curHour)
      // 进行中班段：真实在岗 或 已排本班（引擎到点自动打卡）都算动态调度覆盖
      if (inBand) return !!s.on_duty_now || s.shift_code === band.shift_code
    }
    return true
  }).length
  const gaps = []
  const roleChecks = [
    { role: '保安/安保', needKey: 'need_guard' },
    { role: '保洁', needKey: 'need_clean' },
    { role: '维修工', needKey: 'need_repair' }
  ]
  for (const b of demand.bands) {
    for (const c of roleChecks) {
      const rolesArr = ROLES_BY_NAME[c.role]
      // 维修工需求含投诉驱动（need_repair 已合并检修工单 + 设施类投诉）；保安/保洁需求已含投诉兜底
      const need = b[c.needKey]
      if (!need) continue
      const have = forDispatch ? countRole(b.key, rolesArr) : countByBand(list, day, b.key, r => rolesArr.includes(r))
      if (have >= need) continue
      // 硬需求只认本岗位相关的工单/投诉（维修缺口挂维修工单，保安/保洁缺口不会因为有检修单就变硬）
      const relatedComplaints = b.complaints.filter(x => rolesArr.some(r => (x.roles || []).includes(r)))
      const relatedOrders = c.role === '维修工' ? (b.orders || []) : []
      const hard = relatedOrders.length > 0 || relatedComplaints.length > 0
      // 统一优先级：取该缺口关联的检修工单/投诉中的最高分，驱动补位与紧急调令的先后
      const orderMax = relatedOrders.reduce((m, o) => Math.max(m, num(o.priority)), 0)
      const compMax = relatedComplaints.reduce((m, x) => Math.max(m, num(x.priority)), 0)
      gaps.push({ band: b.key, role: c.role, roles: rolesArr, need, have, gap: need - have, hard,
        priority: Math.max(orderMax, compMax), orders: relatedOrders, complaints: relatedComplaints })
    }
  }
  return { demand, gaps }
}

// 按需求画像为未来 horizon 天（含当天）补齐缺口；返回补位明细。
// 当天未开始班段：正常补排；已开始班段：硬需求（检修/投诉）允许跨班段临班补排（未开始且时段重叠的邻班，
// 如中班缺维修工 → 排未开始的晚班，14 点到岗后即可接单）；仍补不上的缺口转为紧急加班调令（主管审批）。
// env='real'（默认）直接落库；env='plan' 只产出跨日计划草案明细（虚拟排班参与后续缺口计算，不写库）。
export function runDynamicDispatch({ horizon = 3, reason = '', urgentOvertime = false, env = 'real' } = {}) {
  const created = []
  const otRequests = []
  const today = ctx.day()
  const t = ctx.tick()
  const shifts = listShiftTemplates({ activeOnly: true })
  // 计划草案的虚拟排班/拟发调令（仅 env='plan' 使用）
  const planSchedules = []   // 拟补排班 { virtual_id, staff_id, shift_id, day }
  const planOvertimes = []   // 拟发调令 { virtual_id, staff_id, shift_id, day, schedule_id, ot_ticks }
  let virtualSeq = 0

  // 落地一个补班：真实模式写排班；草案模式只登记虚拟排班
  const placeSchedule = (spec) => {
    const { cand, target, d, band, g, noteSuffix, pass, allowStarted } = spec
    if (env === 'plan') {
      virtualSeq += 1
      const v = { virtual_id: virtualSeq, staff_id: cand.id, shift_id: target.id, day: d }
      planSchedules.push(v)
      return { ok: true, virtual: v, wage: estimateScheduleWage(cand.id, target.id) }
    }
    const rr = createSchedule({
      staffId: cand.id, shiftId: target.id, day: d, source: 'dispatch',
      note: reason ? `动态调度：${reason}${noteSuffix}` : `动态调度补${band.label}${g.role}缺口${noteSuffix}`,
      requestId: `disp-${d}-${target.id}-${cand.id}-${band.key}-${pass}`,
      allowStarted
    })
    return rr
  }

  for (let d = today; d <= today + horizon - 1; d++) {
    const extrasForDay = planSchedules.concat(planOvertimes.map(o => ({
      virtual_id: o.virtual_id, staff_id: o.staff_id, shift_id: o.shift_id, day: o.day, virtual_ot: o.ot_ticks
    })))
    // 当日班段处理顺序：硬需求（检修/投诉）按统一优先级最高的班段先补，其次缺口人数；
    // 保证紧急检修/临期投诉先占到人（跨日班次的昨日夜班不参与今日日班补位）
    const gapRank = gapsForDay(d, { extras: extrasForDay }).gaps
    const bandRank = new Map(BANDS.map(b => [b.key, 0]))
    for (const g of gapRank) {
      bandRank.set(g.band, Math.max(bandRank.get(g.band) || 0, (g.hard ? 1000 : 0) + g.priority * 2 + g.gap))
    }
    const dayBands = [...BANDS].sort((a, b2) => (bandRank.get(b2.key) || 0) - (bandRank.get(a.key) || 0))
    // 逐班段 × 岗位缺口补位；每补一个人都会影响候选池与缺口数，故每轮实时重算
    for (const band of dayBands) {
      for (let pass = 0; pass < 24; pass++) {
        // 该班段仍未消解的全部岗位缺口，按硬需求 → 统一优先级 → 缺口人数排序补位
        const gapsNow = gapsForDay(d, { extras: extrasForDay }).gaps
          .filter(x => x.band === band.key && x.gap > 0)
          .sort((a, b2) => Number(b2.hard) - Number(a.hard) || b2.priority - a.priority || b2.gap - a.gap)
        if (!gapsNow.length) break
        const g = gapsNow[0]
        const sh = shifts.find(x => x.code === band.shift_code)
        if (!sh) break
        const curHour = OPEN_HOUR + (t - linear(d, OPEN_HOUR))
        const bandEndHour = band.hours[band.hours.length - 1] + 1
        const bandStarted = d === today && curHour >= sh.start_hour
        const bandLive = d !== today || curHour < bandEndHour

        // 目标班次：班段未开始/进行中 → 本班（进行中用 allowStarted 放进班，引擎随后自动打卡）；
        // 班段已过的硬需求 → 当日未开始且与缺口时段重叠的最近邻班接续；其余缺口不再补排（转加班调令）
        let target = null
        let allowStarted = false
        let noteSuffix = ''
        if (!bandStarted || bandLive) {
          target = sh
          allowStarted = bandStarted
        } else if (g.hard) {
          target = shifts
            .filter(x => !x.cross_day && x.start_hour > curHour && x.start_hour <= band.hours[band.hours.length - 1])
            .sort((a, b2) => a.start_hour - b2.start_hour)[0] || null
          if (target) noteSuffix = `（原${band.label}已过，${target.name}接续补位）`
        }
        if (!target) break
        // 区域/技能匹配：维修缺口优先派给检修工单所在区域的维修工（gaps 已含工单 zone_id）
        const zoneId = g.orders?.[0]?.zone_id ?? null
        const cand = dispatchCandidates(d, g.roles, zoneId, planSchedules, planSchedules)[0]
        if (!cand) break
        const refs = buildGapRefs(g)
        const demandReason = buildDemandReason(band, g)
        const pr = placeSchedule({ cand, target, d, band, g, noteSuffix, pass, allowStarted })
        if (env === 'plan') {
          created.push({
            action: 'add_schedule', day: d, band: band.key, role: g.role,
            staff_id: cand.id, staff_name: cand.name, shift_id: target.id,
            shift_code: target.code, shift_name: target.name, cross_day: target.cross_day ? 1 : 0,
            est_wage: pr.wage, demand_reason: demandReason, refs,
            virtual_id: pr.virtual.virtual_id
          })
        } else {
          if (!pr.ok) break
          created.push({ id: pr.id, code: pr.code, staff_id: cand.id, staff_name: cand.name, day: d, band: band.key, shift: target.code })
        }
      }
    }

    // 班段补排全部尝试后，仍存在的当天已开始班段缺口 → 紧急加班调令（相邻班段在岗员工，主管审批）
    // 按统一优先级（检修/投诉紧急度）先发调令，避免有限的可加班人力被低优先缺口占用
    if (urgentOvertime) {
      const urgentGaps = gapsForDay(d, { extras: extrasForDay }).gaps
        .filter(g => {
          const sh = shifts.find(x => x.code === BANDS.find(b => b.key === g.band).shift_code)
          return sh && d === today && linear(d, sh.start_hour) <= t
        })
        .sort((a, b2) => Number(b2.hard) - Number(a.hard) || b2.priority - a.priority)
      for (const g of urgentGaps) {
        if (env === 'plan') {
          for (const po of previewUrgentOvertime(d, g, reason, planOvertimes)) {
            virtualSeq += 1
            po.virtual_id = virtualSeq
            planOvertimes.push({ virtual_id: virtualSeq, staff_id: po.staff_id, shift_id: po.shift_id, day: d, schedule_id: po.schedule_id, ot_ticks: po.ticks })
            otRequests.push(po)
          }
        } else {
          otRequests.push(...createUrgentOvertime(d, g, reason))
        }
      }
    }
  }
  return { ok: true, created, otRequests, days: horizon, env }
}

// 缺口关联依据快照（检修工单/投诉，含统一优先级分值）
function buildGapRefs(g) {
  const refs = []
  for (const o of (g.orders || [])) refs.push({ kind: 'order', id: o.id, code: o.code, priority: num(o.priority), name: o.ride_name })
  for (const c of (g.complaints || [])) refs.push({ kind: 'complaint', id: c.id, code: c.code, priority: num(c.priority), severity: c.severity })
  return refs
}
function buildDemandReason(band, g) {
  const parts = []
  if (g.orders?.length) parts.push(`检修工单 ${g.orders.map(o => o.code).join('、')}`)
  if (g.complaints?.length) parts.push(`投诉 ${g.complaints.map(c => c.code).join('、')}`)
  return parts.length ? parts.join('；') : `${band.label}客流峰值驱动`
}

// 计划草案的预计工资：按班次基准工时（含加班 1.5×）以员工当前日薪折算（批准时按当时日薪重算，保持与工资口径一致）
function estimateScheduleWage(staffId, shiftId, otTicks = 0) {
  const st = getStaff(staffId)
  const sh = getShift(shiftId)
  if (!st || !sh) return 0
  const hourly = hourlyWage(st.wage)
  const otMul = num(getSetting('otRateMul'), 1.5)
  return Math.round(hourly * (sh.standard_hours || 5)) + Math.round(hourly * otMul * otTicks)
}

// 紧急加班调令：班段已开始且补不上人时，给相邻班段在岗、岗位匹配的员工生成系统加班申请（主管审批）
function createUrgentOvertime(day, gap, reason) {
  const out = []
  const t = ctx.tick()
  // 找当前在岗、岗位匹配、加班不超时段限制、且没有待审批加班申请的员工
  const onDuty = roster(day).filter(s => s.on_duty_now && !s.cross_day)
  const roles = ROLES_BY_NAME[gap.role] || ROLES_BY_NAME['维修工']
  let need = gap.gap
  for (const s of onDuty) {
    if (need <= 0) break
    if (!roles.includes(s.role)) continue
    const sh = getShift(s.shift_id)
    if (!sh) continue
    const att = db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(s.schedule_id)
    if (!att || att.status !== 'checked_in') continue
    // 加班补到当前班段结束（中班缺口补到 17:00、晚班缺口补到闭园 18:00），日班加班上限 4h
    const curHour = OPEN_HOUR + (t - linear(day, OPEN_HOUR))
    const bandEnd = gap.band === 'morning' ? 14 : gap.band === 'mid' ? 17 : CLOSE_HOUR
    const ticks = Math.min(4, Math.max(1, bandEnd - curHour - att.overtime_ticks))
    if (sh.end_hour + att.overtime_ticks + ticks > CLOSE_HOUR) continue
    const dup = db.prepare("SELECT id FROM shift_requests WHERE kind='overtime' AND status='pending' AND schedule_id=?").get(s.schedule_id)
    if (dup) continue
    const id = Number(db.prepare(`INSERT INTO shift_requests(kind,staff_id,schedule_id,day,ot_ticks,reason,status,source,create_tick,create_day)
                                 VALUES('overtime',?,?,?,?,?, 'pending','dispatch',?,?)`)
      .run(s.id, s.schedule_id, day, ticks,
        `系统紧急调令：${gap.band === 'morning' ? '早' : gap.band === 'mid' ? '中' : '晚'}班${gap.role}缺岗 ${gap.gap} 人${reason ? `（${reason}）` : ''}，请加班补位`,
        t, day).lastInsertRowid)
    const code = 'TB' + String(id).padStart(4, '0')
    db.prepare('UPDATE shift_requests SET code=? WHERE id=?').run(code, id)
    logShift({
      scheduleId: s.schedule_id, attendanceId: att.id, requestId: id, action: 'ot_request',
      note: `动态调度生成紧急加班调令：${s.name}${gap.role}加班 ${ticks}h 补 ${gap.band}班缺口，待主管审批`, staffId: s.id
    })
    out.push({ id, code, staff_id: s.id, ticks })
    need--
  }
  return out
}

// 计划草案版紧急调令：不写 shift_requests，按与 createUrgentOvertime 相同的选人/时限口径产出拟发调令；
// planSchedules 中已拟发给同一员工的调令去重，避免草案里重复占人。
function previewUrgentOvertime(day, gap, reason, planOvertimes = []) {
  const out = []
  const t = ctx.tick()
  const onDuty = roster(day).filter(s => s.on_duty_now && !s.cross_day)
  const roles = ROLES_BY_NAME[gap.role] || ROLES_BY_NAME['维修工']
  let need = gap.gap
  for (const s of onDuty) {
    if (need <= 0) break
    if (!roles.includes(s.role)) continue
    const sh = getShift(s.shift_id)
    if (!sh) continue
    const att = db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(s.schedule_id)
    if (!att || att.status !== 'checked_in') continue
    const curHour = OPEN_HOUR + (t - linear(day, OPEN_HOUR))
    const bandEnd = gap.band === 'morning' ? 14 : gap.band === 'mid' ? 17 : CLOSE_HOUR
    const ticks = Math.min(4, Math.max(1, bandEnd - curHour - att.overtime_ticks))
    if (sh.end_hour + att.overtime_ticks + ticks > CLOSE_HOUR) continue
    const dupReal = db.prepare("SELECT id FROM shift_requests WHERE kind='overtime' AND status='pending' AND schedule_id=?").get(s.schedule_id)
    if (dupReal) continue
    // 草案内去重：同一在岗排班只拟一条调令
    if (out.some(x => x.schedule_id === s.schedule_id)) continue
    if (planOvertimes.some(e => e.schedule_id === s.schedule_id)) continue
    const refs = buildGapRefs(gap)
    out.push({
      action: 'add_overtime', day, band: gap.band, role: gap.role,
      staff_id: s.id, staff_name: s.name, shift_id: s.shift_id,
      shift_code: s.shift_code, shift_name: s.shift_name, cross_day: 0,
      schedule_id: s.schedule_id, attendance_id: att.id, ticks, ot_ticks: ticks,
      est_wage: estimateScheduleWage(s.id, s.shift_id, ticks),
      demand_reason: `紧急加班调令：${buildDemandReason(BANDS.find(b => b.key === gap.band), gap)}${reason ? `（${reason}）` : ''}`,
      refs
    })
    need--
  }
  return out
}

// 操作联动钩子：调班批准/取消/解雇/报修/投诉建单/库存变化后触发。
// 审批模式：维护待审批跨日计划（不存在则生成草案，存在则标记需求已变化）；否则直接按缺口补位。
export function maybeDispatchAfter(reason = '岗位需求变化') {
  if (!num(getSetting('scheduleAutoFill'), 1)) return { ok: true, skipped: true }
  if (getSetting('scheduleMode', 'dynamic') !== 'dynamic') return { ok: true, skipped: true }
  try {
    if (num(getSetting('schedulePlanApproval'), 0)) return autoMaintainPlan(reason)
    return runDynamicDispatch({ reason })
  } catch (e) {
    console.error('[scheduling] 联动动态调度失败（不影响主操作）:', e)
    return { ok: false, msg: '动态调度失败' }
  }
}

// ---------------- 引擎：自动补位 / 打卡 / 工时累计 / 下班结算 ----------------
// 基础模式：为未来 horizon-1 天无有效排班的在岗员工按轮换补排日班（兼容旧玩法）
function autoFillSchedules() {
  if (!num(getSetting('scheduleAutoFill'), 1)) return
  if (!db.prepare('SELECT COUNT(*) n FROM shift_templates WHERE active=1').get().n) return
  if (getSetting('scheduleMode', 'dynamic') === 'dynamic') {
    // 动态模式：按预约客流 / 检修工单 / 投诉岗位需求补缺口（含当天紧急加班调令）
    if (num(getSetting('schedulePlanApproval'), 0)) {
      // 跨日计划审批模式：引擎不直接写排班，改为维护待主管审批的跨日计划草案
      autoMaintainPlan('引擎每小时需求巡检')
    } else {
      runDynamicDispatch({ horizon: 3, urgentOvertime: true, reason: '引擎每小时需求巡检' })
    }
    return
  }
  const dayShifts = listShiftTemplates({ activeOnly: true }).filter(s => !s.cross_day)
  if (!dayShifts.length) return
  const today = ctx.day()
  for (let d = today; d <= today + 2; d++) {
    const staff = db.prepare("SELECT * FROM staff WHERE active=1 AND role<>'运营主管' ORDER BY id").all()
    for (const st of staff) {
      if (effectiveScheduleOf(st.id, d)) continue
      if (workedNightBefore(st.id, d)) continue
      const sh = dayShifts[Math.abs(st.id * 7 + d * 3) % dayShifts.length]
      // 当天只补排尚未开始的班次
      if (d === today && linear(d, sh.start_hour) <= ctx.tick()) continue
      createSchedule({ staffId: st.id, shiftId: sh.id, day: d, source: 'auto' })
    }
  }
}

// 每游戏小时推进：自动排班 → 到点打卡 → 出勤工时累计 → 下班结算 / 旷工标记（跨日夜班次日结算）
export function processScheduling() {
  autoFillSchedules()
  const t = ctx.tick()
  const scheds = db.prepare(`SELECT * FROM staff_schedules WHERE ${EFFECTIVE} ORDER BY id`).all()
  for (const sch of scheds) {
    try {
      const sh = getShift(sch.shift_id)
      if (!sh) continue
      const { begin, end } = shiftBounds(sch, sh)
      const att = attendanceBySchedule(sch.id)
      if (!att) {
        if (t >= begin && t < end) {
          // 到点未打卡（引擎每小时执行，正常与开始时刻同 tick）→ 自动打卡
          checkin(sch.id)
        } else if (t >= end) {
          tx(() => markAbsent(sch, sh))
        }
      } else if (att.status === 'checked_in') {
        const workTicks = Math.max(0, t - att.checkin_tick)
        if (t >= end + att.overtime_ticks) {
          settleAttendance({ ...att, work_ticks: workTicks }, 'checked_out')
        } else if (workTicks !== att.work_ticks) {
          db.prepare('UPDATE staff_attendance SET work_ticks=? WHERE id=?').run(workTicks, att.id)
        }
      }
    } catch (e) {
      // 逐人容错：一人考勤异常不拖垮整批与游戏主循环（结算事务已回滚）
      console.error(`[scheduling] 排班 #${sch.id} 推进失败（已跳过）:`, e)
    }
  }
}

// 日结汇总：闭园时统计当日旷工（跨日夜班次日才结算，不在此列）
export function dayCloseSummary(day) {
  const absent = db.prepare('SELECT COUNT(*) n FROM staff_attendance WHERE day=? AND cross_day=0 AND status=?').get(day, 'absent').n
  // 当日下班/离岗结算（settle_day=day，含跨日夜班次日下班）的人数、工资与加班
  const settled = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(pay),0) p, COALESCE(SUM(overtime_ticks),0) ot FROM staff_attendance WHERE settle_day=? AND status IN ('checked_out','leave')").get(day)
  const left = db.prepare('SELECT COUNT(*) n FROM staff_attendance WHERE settle_day=? AND status=?').get(day, 'leave').n
  return { absent, settledCount: settled.n, totalPay: settled.p, overtimeHours: settled.ot, leaveCount: left }
}

// ---------------- 完工回写（检修/投诉处置完工 → 工时与满意度回流） ----------------
// 检修工单完工 / 投诉补偿结案时调用：给当值员工本班满意度加分（维修 +3 / 投诉 +2），结算时统一落到士气
export function writeWorkCompletion(staffId, kind, meta = {}) {
  if (!staffId) return { ok: false }
  const att = db.prepare("SELECT * FROM staff_attendance WHERE staff_id=? AND status='checked_in' ORDER BY id DESC LIMIT 1").get(staffId)
  if (!att) return { ok: false, msg: '员工当前不在岗，完工满意度不回写' }
  const delta = kind === 'maintenance' ? 3 : 2
  const label = kind === 'maintenance' ? '设施检修完工' : '投诉处置结案'
  db.prepare('UPDATE staff_attendance SET satisfaction_delta=satisfaction_delta+? WHERE id=?').run(delta, att.id)
  const note = `${label}满意度 +${delta}${meta.code ? `（${meta.code}）` : ''}`
  db.prepare('UPDATE staff_attendance SET note=? WHERE id=?').run(String((att.note ? att.note + '；' : '') + note).slice(0, 200), att.id)
  logShift({ scheduleId: att.schedule_id, attendanceId: att.id, action: 'workdone', note, staffId })
  return { ok: true, attendance_id: att.id, delta }
}

// 派工校验：检修接单 / 投诉受理时检查员工当日排班与当前在岗状态
// 返回 { scheduled, onDuty, attendanceId, msg }；onDuty=false 时进度推进暂停（不视为离岗退单）
export function staffDutyState(staffId) {
  const st = getStaff(staffId)
  if (!st || !st.active) return { scheduled: false, onDuty: false, msg: '员工不存在或已离岗' }
  const t = ctx.tick()
  const sch = effectiveScheduleOf(staffId, ctx.day())
  if (!sch) return { scheduled: false, onDuty: false, msg: `${st.name} 今日无排班，不能派工` }
  const sh = getShift(sch.shift_id)
  const { begin, end } = shiftBounds(sch, sh)
  const att = attendanceBySchedule(sch.id)
  if (att && att.status === 'checked_in') {
    if (t >= begin && t < end + att.overtime_ticks) return { scheduled: true, onDuty: true, attendanceId: att.id, scheduleId: sch.id }
    return { scheduled: true, onDuty: false, attendanceId: att.id, scheduleId: sch.id, msg: `${st.name} 当前不在班次时段内` }
  }
  // 跨日夜班：昨日的夜班考勤今早仍在岗
  const night = db.prepare(`
    SELECT a.* FROM staff_attendance a
    JOIN shift_templates sh ON sh.id=a.shift_id
    WHERE a.staff_id=? AND a.status='checked_in' AND sh.cross_day=1 AND a.day=?`).get(staffId, ctx.day() - 1)
  if (night) return { scheduled: true, onDuty: true, attendanceId: night.id, scheduleId: night.schedule_id }
  return { scheduled: true, onDuty: false, scheduleId: sch.id, msg: `${st.name} 今日有排班但尚未打卡上班` }
}

// ---------------- 查询 ----------------
function enrichSchedule(sch) {
  const st = getStaff(sch.staff_id)
  const sh = db.prepare('SELECT * FROM shift_templates WHERE id=?').get(sch.shift_id)
  const att = attendanceBySchedule(sch.id)
  const bounds = sh ? shiftBounds(sch, sh) : { begin: 0, end: 0 }
  const t = ctx.tick()
  const x = {
    ...sch,
    staff_name: st?.name || '',
    staff_role: st?.role || '',
    staff_active: st ? !!st.active : false,
    staff_zone_id: st?.zone_id ?? null,
    shift_name: sh?.name || '',
    shift_code: sh?.code || '',
    shift_color: sh?.color || '#66a6ff',
    start_hour: sh?.start_hour ?? 0,
    end_hour: sh?.end_hour ?? 0,
    cross_day: sh?.cross_day ?? 0,
    standard_hours: sh?.standard_hours ?? 5,
    time_text: sh ? (sh.cross_day ? `${sh.start_hour}:00~次日${String(sh.end_hour).padStart(2, '0')}:00` : `${sh.start_hour}:00~${sh.end_hour}:00`) : '',
    begin_linear: bounds.begin,
    end_linear: bounds.end,
    att_status: att?.status || '',
    att_code: att?.code || '',
    work_ticks: att?.work_ticks || 0,
    overtime_ticks: att?.overtime_ticks || 0,
    ot_approved: att?.ot_approved ? 1 : 0,
    late: att?.late ? 1 : 0,
    pay: att?.pay || 0,
    satisfaction_delta: att?.satisfaction_delta || 0,
    attendance_id: att?.id || null,
    on_duty: att?.status === 'checked_in' && t >= bounds.begin && t < bounds.end + (att.overtime_ticks || 0),
    night_phase: ''
  }
  // 跨日夜班在看板上的实时阶段：upcoming 未到岗 / night_on 当夜值守 / morning_after 次日凌晨值守 / done 已下班
  if (sh?.cross_day) {
    const nightStart = linear(sch.day, sh.start_hour)
    if (t < nightStart) x.night_phase = 'upcoming'
    else if (t < linear(sch.day, CLOSE_HOUR)) x.night_phase = 'night_on'
    else if (t < bounds.end || (att?.status === 'checked_in' && t < bounds.end + (att.overtime_ticks || 0))) x.night_phase = 'morning_after'
    else x.night_phase = 'done'
  }
  return x
}

export function listSchedules({ day = null, from = null, to = null, staffId = null, status = null, limit = 500 } = {}) {
  const where = []
  const args = []
  if (day !== null) { where.push('day=?'); args.push(day) }
  if (from !== null) { where.push('day>=?'); args.push(from) }
  if (to !== null) { where.push('day<=?'); args.push(to) }
  if (staffId) { where.push('staff_id=?'); args.push(staffId) }
  if (status) { where.push('status=?'); args.push(status) }
  const sql = `SELECT * FROM staff_schedules ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY day DESC,id DESC LIMIT ?`
  args.push(limit)
  return db.prepare(sql).all(...args).map(enrichSchedule)
}

export function listAttendance({ day = null, staffId = null, status = null, settleDay = null, limit = 200 } = {}) {
  const where = []
  const args = []
  if (day !== null) { where.push('day=?'); args.push(day) }
  if (settleDay !== null) { where.push('settle_day=?'); args.push(settleDay) }
  if (staffId) { where.push('staff_id=?'); args.push(staffId) }
  if (status) { where.push('status=?'); args.push(status) }
  const rows = db.prepare(`SELECT * FROM staff_attendance ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit)
  return rows.map(a => {
    const st = getStaff(a.staff_id)
    const sh = db.prepare('SELECT * FROM shift_templates WHERE id=?').get(a.shift_id)
    return {
      ...a,
      staff_name: st?.name || '',
      staff_role: st?.role || '',
      shift_name: sh?.name || '',
      shift_color: sh?.color || '#66a6ff',
      time_text: sh ? (sh.cross_day ? `${sh.start_hour}:00~次日${String(sh.end_hour).padStart(2, '0')}:00` : `${sh.start_hour}:00~${sh.end_hour}:00`) : '',
      hourly_wage: hourlyWage(st?.wage ?? 300)
    }
  })
}

export function listRequests({ status = null, kind = null, limit = 200 } = {}) {
  const where = []
  const args = []
  if (status) { where.push('r.status=?'); args.push(status) }
  if (kind) { where.push('r.kind=?'); args.push(kind) }
  const rows = db.prepare(`
    SELECT r.*, s.name staff_name, s.role staff_role, s.active staff_active,
           t.name target_name, t.role target_role,
           sh.name shift_name, tsh.name target_shift_name, tsh.cross_day target_cross_day
    FROM shift_requests r
    JOIN staff s ON s.id=r.staff_id
    LEFT JOIN staff t ON t.id=r.target_staff_id
    LEFT JOIN shift_templates sh ON sh.id=(SELECT shift_id FROM staff_schedules WHERE id=r.schedule_id)
    LEFT JOIN shift_templates tsh ON tsh.id=r.target_shift_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.id DESC LIMIT ?`).all(...args, limit)
  return rows
}

export function shiftLogs(ref) {
  const where = []
  const args = []
  if (ref.scheduleId) { where.push('schedule_id=?'); args.push(ref.scheduleId) }
  if (ref.attendanceId) { where.push('attendance_id=?'); args.push(ref.attendanceId) }
  if (ref.requestId) { where.push('request_id=?'); args.push(ref.requestId) }
  if (ref.planId) { where.push('plan_id=?'); args.push(ref.planId) }
  if (!where.length) return []
  return db.prepare(`SELECT l.*, s.name staff_name, ap.name approver_name
                     FROM shift_logs l
                     LEFT JOIN staff s ON s.id=l.staff_id
                     LEFT JOIN staff ap ON ap.id=l.approver_id
                     WHERE ${where.join(' OR ')} ORDER BY l.id`).all(...args)
}

export function schedulingStats() {
  const day = ctx.day()
  const todaySched = db.prepare(`SELECT COUNT(*) n FROM staff_schedules WHERE day=? AND ${EFFECTIVE}`).get(day).n
  const onDuty = db.prepare("SELECT COUNT(*) n FROM staff_attendance WHERE status='checked_in' AND checkin_tick<=? AND checkout_tick=0").get(ctx.tick()).n
  const absent = db.prepare('SELECT COUNT(*) n FROM staff_attendance WHERE day=? AND status=?').get(day, 'absent').n
  const late = db.prepare('SELECT COUNT(*) n FROM staff_attendance WHERE day=? AND late=1').get(day).n
  const ot = db.prepare('SELECT COALESCE(SUM(overtime_ticks),0) n FROM staff_attendance WHERE day=? AND ot_approved=1').get(day).n
  const payRow = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(pay),0) p FROM staff_attendance WHERE settle_day=? AND status IN ('checked_out','leave')").get(day)
  const pending = db.prepare("SELECT COUNT(*) n FROM shift_requests WHERE status='pending'").get().n
  const dispatchOt = db.prepare("SELECT COUNT(*) n FROM shift_requests WHERE status='pending' AND source='dispatch'").get().n
  const dispatchToday = db.prepare(`SELECT COUNT(*) n FROM staff_schedules WHERE create_day=? AND source='dispatch'`).get(day).n
  // 跨日夜班：前一日 17 点上班、当前仍在岗（次日凌晨值守）的人数（次日 9:00 即自动结算）
  const nightOn = db.prepare(`SELECT COUNT(*) n FROM staff_attendance a
    JOIN shift_templates sh ON sh.id=a.shift_id
    WHERE a.status='checked_in' AND sh.cross_day=1 AND a.day=?`).get(day - 1).n
  // 跨日计划：待审批计划数、是否需求已变化、计划内补班/调令与预计工资
  const pendingPlanRow = db.prepare("SELECT id,item_count,est_wage FROM schedule_plans WHERE status='pending' ORDER BY id DESC LIMIT 1").get()
  let pendingPlanStale = 0
  let pendingPlanSchedules = 0
  let pendingPlanOvertimes = 0
  if (pendingPlanRow) {
    const pp = db.prepare('SELECT * FROM schedule_plans WHERE id=?').get(pendingPlanRow.id)
    pendingPlanStale = planIsStale(pp)
    pendingPlanSchedules = db.prepare("SELECT COUNT(*) n FROM schedule_plan_items WHERE plan_id=? AND action='add_schedule' AND status='pending'").get(pp.id).n
    pendingPlanOvertimes = db.prepare("SELECT COUNT(*) n FROM schedule_plan_items WHERE plan_id=? AND action='add_overtime' AND status='pending'").get(pp.id).n
  }
  const coverage = coverageForDay(day)
  return {
    day,
    todayScheduled: todaySched,
    onDuty,
    absentToday: absent,
    lateToday: late,
    overtimeHoursToday: ot,
    settledToday: payRow.n,
    payToday: payRow.p,
    pendingRequests: pending,
    dispatchOtRequests: dispatchOt,
    dispatchFilledToday: dispatchToday,
    nightOnDuty: nightOn,
    flowToday: coverage.demand.flowTotal,
    coverageWarnings: coverage.warnings.length,
    coverageBlocks: coverage.warnings.filter(w => w.level === 'block').length,
    planApprovalMode: num(getSetting('schedulePlanApproval'), 0) ? 1 : 0,
    pendingPlan: pendingPlanRow ? 1 : 0,
    pendingPlanId: pendingPlanRow?.id || null,
    pendingPlanStale,
    pendingPlanItems: pendingPlanRow?.item_count || 0,
    pendingPlanSchedules,
    pendingPlanOvertimes,
    pendingPlanWage: pendingPlanRow?.est_wage || 0
  }
}

// ---------------- 跨日排班计划：需求画像 → 跨日草案预览 → 主管审批 → 原子落地 ----------------
const PLAN_HORIZON = 3

// 计划是否已过期：只比对「明天及以后、且计划仍覆盖」的游戏日指纹——
// 当天需求随预约核销/散客到园在日内自然回落，属正常消耗而非未来排班变化，不计入（当天项在批准时实时校验）；
// 游戏跨天后已过去的日子同样不参与。窗口内未来日客流跨阈值/新工单/新投诉/排班被改动才标记 1。
function planIsStale(plan) {
  if (plan.status !== 'pending') return 0
  let stored
  try { stored = JSON.parse(plan.demand_signature) } catch { return 0 }
  for (let d = Math.max(ctx.day() + 1, plan.day_from); d <= plan.day_to; d++) {
    if (stored[`D${d}`] !== planDaySignature(d)) return 1
  }
  return 0
}

// 单日需求指纹：只含「是否改变排班结果」的稳定前瞻信号——
// 班段 × 岗位所需人数（客流折算每 N 人才跳一档，几张预约的微小波动不会误报；硬需求工单/投诉另列）、
// 在途检修工单号集合（不含进度/接单等处置抖动）、在途投诉身份/严重度/升级/截止、
// 有效排班与在册人数。这样引擎正常推进预约核销、检修/投诉处置时不会把在审计划误判为过期，
// 只有客流累积跨过承载阈值、出现新工单/新投诉或排班被改动时才标记「需求已变化」。
function planDaySignature(d) {
  const demand = demandForDay(d)
  const needByBand = demand.bands.map(b =>
    `${b.key}:${b.need_guard}|${b.need_clean}|${b.need_repair}`).join(';')
  const orders = db.prepare("SELECT id FROM maintenance_orders WHERE status IN ('queued','processing') ORDER BY id").all()
    .map(o => o.id).join(',')
  const comps = db.prepare("SELECT id,severity,escalated,deadline_tick,category FROM complaints WHERE status IN ('open','processing','ready') ORDER BY id").all()
    .filter(c => (ctx.complaintRoles?.[c.category] || []).length)
    .map(c => `${c.id}@${c.severity}@${c.escalated}@${c.deadline_tick}`).join(',')
  const roster = db.prepare(`SELECT sc.staff_id, sc.shift_id FROM staff_schedules sc
    WHERE sc.${EFFECTIVE} AND sc.day=? ORDER BY sc.id`).all(d)
    .map(r => `${r.staff_id}:${r.shift_id}`).join(',')
  const staffN = db.prepare('SELECT COUNT(*) n FROM staff WHERE active=1').get().n
  return `N[${needByBand}]O{${orders}}C{${comps}}R{${roster}}S${staffN}`
}

// 指定日期窗口的需求指纹（按游戏日键控的 JSON）；跨天后只比对计划仍覆盖的未来日
function planDemandSignatureForRange(dayFrom, dayTo) {
  const map = {}
  for (let d = dayFrom; d <= dayTo; d++) map[`D${d}`] = planDaySignature(d)
  map.params = `${num(getSetting('dispatchGuardFlow'), 500)}|${num(getSetting('dispatchCleanFlow'), 700)}|${num(getSetting('dispatchNightGuardsPerZone'), 0)}|${num(getSetting('otRateMul'), 1.5)}`
  return JSON.stringify(map)
}

// 需求指纹：今天起未来 horizon 天的稳定前瞻需求（客流预约/工单/投诉/排班/参数）
export function planDemandSignature(horizon = PLAN_HORIZON) {
  const today = ctx.day()
  return planDemandSignatureForRange(today, today + horizon - 1)
}

// 草案条目 → 计划明细行（统一装配）
function persistPlanItems(planId, items) {
  const ins = db.prepare(`INSERT INTO schedule_plan_items
    (plan_id,day,band,role,action,staff_id,shift_id,schedule_id,attendance_id,ot_ticks,est_wage,demand_reason,refs_json,status,create_tick,create_day)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?)`)
  for (const it of items) {
    ins.run(planId, it.day, it.band, it.role, it.action, it.staff_id, it.shift_id,
      it.schedule_id || null, it.attendance_id || null, it.ot_ticks || 0, it.est_wage || 0,
      String(it.demand_reason || '').slice(0, 200), JSON.stringify(it.refs || []), ctx.tick(), ctx.day())
  }
}

// 生成跨日计划（幂等）：按当前需求画像 dry-run 未来 horizon 天补班与紧急调令，落为待审批草案。
// 若已存在待审批计划：replace=true（主管手动刷新）先原子废弃旧草案再生成；否则返回冲突（引擎巡检不覆盖主管在看的计划）。
export function generateSchedulePlan({ horizon = PLAN_HORIZON, reason = '', source = 'manual', requestId = '', replace = true } = {}) {
  return idempotent('schedule_plan_generate', requestId, () => {
    try {
      return tx(() => {
        horizon = Math.max(1, Math.min(5, Math.round(num(horizon, PLAN_HORIZON))))
        const pending = db.prepare("SELECT id FROM schedule_plans WHERE status='pending'").get()
        if (pending && !replace) {
          return fail('PLAN_PENDING_EXISTS', '已有待审批的跨日计划，请先审批或刷新', { pending_id: pending.id })
        }
        if (pending) {
          db.prepare("UPDATE schedule_plans SET status='cancelled', handle_tick=?, handle_day=?, handle_note='需求变化，主管刷新生成新计划' WHERE id=?")
            .run(ctx.tick(), ctx.day(), pending.id)
        }
        const sim = runDynamicDispatch({ horizon, urgentOvertime: true, reason: reason || '跨日计划草案', env: 'plan' })
        const items = [...sim.created, ...sim.otRequests]
        const today = ctx.day()
        const estWage = items.reduce((s, it) => s + num(it.est_wage), 0)
        const id = Number(db.prepare(`INSERT INTO schedule_plans
          (status,horizon,day_from,day_to,reason,source,demand_signature,item_count,est_wage,create_tick,create_day)
          VALUES('pending',?,?,?,?,?,?,?,?,?,?)`)
          .run(horizon, today, today + horizon - 1,
            String(reason || '').slice(0, 120), source === 'engine' ? 'engine' : 'manual',
            planDemandSignature(horizon), items.length, estWage, ctx.tick(), ctx.day()).lastInsertRowid)
        const code = 'JH' + String(id).padStart(4, '0')
        db.prepare('UPDATE schedule_plans SET code=? WHERE id=?').run(code, id)
        persistPlanItems(id, items)
        logPlan(id, code, 'plan_create',
          `生成跨日计划（第${today}~${today + horizon - 1}天）：补班 ${sim.created.length} 项、紧急加班调令 ${sim.otRequests.length} 项，预计新增工资 ¥${estWage}`,
          { approverId: source === 'engine' ? null : null })
        return { ok: true, id, code, item_count: items.length, schedule_count: sim.created.length, overtime_count: sim.otRequests.length, est_wage: estWage }
      })
    } catch (e) {
      console.error('[scheduling] 生成跨日计划失败，已整体回滚:', e)
      return fail('TX_FAILED', '系统繁忙，跨日计划未生成，请稍后重试')
    }
  })
}

// 引擎/联动调用：有待审批计划则按最新需求指纹标记过期（不覆盖内容）；无则自动生成草案
function autoMaintainPlan(reason = '引擎每小时需求巡检') {
  return tx(() => {
    const pending = db.prepare("SELECT * FROM schedule_plans WHERE status='pending' ORDER BY id DESC LIMIT 1").get()
    if (pending) {
      // 计划窗口已整体过去则交给引擎生成新计划（生成时会原子废弃过期 pending）
      if (pending.day_to < ctx.day()) {
        db.prepare("UPDATE schedule_plans SET status='cancelled', handle_tick=?, handle_day=?, handle_note='计划窗口已过，引擎滚动生成新计划' WHERE id=?")
          .run(ctx.tick(), ctx.day(), pending.id)
        const r = generateSchedulePlan({ reason, source: 'engine' })
        return { ok: true, maintained: true, rolled: true, generated: r.ok ? r.id : null }
      }
      const staleNow = (() => {
        let stored
        try { stored = JSON.parse(pending.demand_signature) } catch { return false }
        // 仅比对未来日；当天需求随营业自然核销回落不算需求变化（当天项批准时实时校验）
        for (let d = Math.max(ctx.day() + 1, pending.day_from); d <= pending.day_to; d++) {
          if (stored[`D${d}`] !== planDaySignature(d)) return true
        }
        return false
      })()
      if (staleNow) {
        // 仅在需求确实变化时写一次时间线，避免每小时刷屏
        db.prepare("UPDATE schedule_plans SET reason=? WHERE id=?").run(String(reason).slice(0, 120), pending.id)
        logPlan(pending.id, pending.code, 'plan_stale', `客流预约/检修工单/投诉/排班发生变化，计划需求依据已更新，请刷新或按最新需求核对后审批`)
      }
      return { ok: true, maintained: true, plan_id: pending.id, stale: staleNow ? 1 : 0 }
    }
    const r = generateSchedulePlan({ reason, source: 'engine' })
    return { ok: true, maintained: true, generated: r.ok ? r.id : null, error: r.ok ? null : r.code }
  })
}

// 批准前逐条校验（事务内）：返回 { valid, reason }
function validateScheduleItem(it) {
  const st = getStaff(it.staff_id)
  if (!st || !st.active) return { valid: false, reason: '员工已离岗' }
  const sh = getShift(it.shift_id)
  if (!sh) return { valid: false, reason: '班次已停用' }
  if (it.day < ctx.day()) return { valid: false, reason: '目标日期已过' }
  const begin = linear(it.day, sh.start_hour)
  const endB = sh.cross_day ? linear(it.day + 1, sh.end_hour) : linear(it.day, sh.end_hour)
  if (it.day === ctx.day() && ctx.tick() >= endB) return { valid: false, reason: '班段已结束' }
  if (effectiveScheduleOf(st.id, it.day)) return { valid: false, reason: `${st.name} 当日已有排班（冲突）` }
  if (workedNightBefore(st.id, it.day)) return { valid: false, reason: '前夜夜班疲劳规避' }
  return { valid: true, allowStarted: it.day === ctx.day() && begin <= ctx.tick() && ctx.tick() < endB }
}
function validateOvertimeItem(it) {
  const att = it.attendance_id ? db.prepare("SELECT * FROM staff_attendance WHERE id=?").get(it.attendance_id) : null
  const realAtt = !att && it.schedule_id ? db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(it.schedule_id) : att
  if (!realAtt || realAtt.status !== 'checked_in') return { valid: false, reason: '员工已不在岗' }
  if (db.prepare("SELECT id FROM shift_requests WHERE kind='overtime' AND status='pending' AND schedule_id=?").get(realAtt.schedule_id)) {
    return { valid: false, reason: '该员工已有待审批加班申请' }
  }
  const sh = getShift(realAtt.shift_id)
  const maxEnd = sh?.cross_day ? 12 : CLOSE_HOUR
  if (!sh || sh.end_hour + realAtt.overtime_ticks + it.ot_ticks > maxEnd) return { valid: false, reason: '加班超出营业时段限制' }
  return { valid: true, att: realAtt, sh }
}

// 主管批准跨日计划（幂等）：同一事务原子落地全部补班/调令；单项失败只跳过该项并留痕，不影响其余。
// 批准提交后再按最新需求补缺（审批模式下登记为新草案或直接提示缺口），保证岗位覆盖与计划一致。
export function approveSchedulePlan(planId, { approverId = null, note = '', requestId = '' } = {}) {
  return idempotent('schedule_plan_approve', requestId, () => {
    let result
    try {
      result = tx(() => {
        const plan = db.prepare("SELECT * FROM schedule_plans WHERE id=?").get(planId)
        if (!plan) return fail('PLAN_NOT_FOUND', '跨日计划不存在')
        if (plan.status === 'approved') return fail('PLAN_HANDLED', '该计划已批准', { plan_id: plan.id })
        if (plan.status !== 'pending') return fail('PLAN_GONE', `该计划已${plan.status === 'rejected' ? '驳回' : '废弃'}，不能批准`)
        const items = db.prepare('SELECT * FROM schedule_plan_items WHERE plan_id=? ORDER BY id').all(planId)
        const applied = []
        const skipped = []
        const appliedSchedules = []
        const appliedOvertimes = []
        for (const it of items) {
          if (it.action === 'add_schedule') {
            const v = validateScheduleItem(it)
            if (!v.valid) {
              db.prepare("UPDATE schedule_plan_items SET status='skipped', skip_reason=? WHERE id=?").run(v.reason, it.id)
              skipped.push({ id: it.id, action: it.action, reason: v.reason })
              continue
            }
            const st = getStaff(it.staff_id)
            const sh = getShift(it.shift_id)
            const ins = db.prepare(`INSERT INTO staff_schedules(staff_id,shift_id,day,status,source,create_tick,create_day,note)
                                   VALUES(?,?,?, 'scheduled','dispatch',?,?,?)`)
              .run(st.id, sh.id, it.day, ctx.tick(), ctx.day(),
                `跨日计划${plan.code}批准落地：${String(it.demand_reason || '').slice(0, 60)}`)
            const sid = Number(ins.lastInsertRowid)
            const scode = 'PB' + String(sid).padStart(4, '0')
            db.prepare('UPDATE staff_schedules SET code=? WHERE id=?').run(scode, sid)
            db.prepare("UPDATE schedule_plan_items SET status='applied', result_schedule_id=? WHERE id=?").run(sid, it.id)
            logShift({
              scheduleId: sid, planId: plan.id, action: 'plan_item_apply',
              note: `跨日计划补位：${st.name} 排入 ${sh.name}（第${it.day}天）· ${it.demand_reason}`, staffId: st.id, approverId
            })
            applied.push({ id: it.id, schedule_id: sid })
            appliedSchedules.push(sid)
          } else if (it.action === 'add_overtime') {
            const v = validateOvertimeItem(it)
            if (!v.valid) {
              db.prepare("UPDATE schedule_plan_items SET status='skipped', skip_reason=? WHERE id=?").run(v.reason, it.id)
              skipped.push({ id: it.id, action: it.action, reason: v.reason })
              continue
            }
            const { att, sh } = v
            // 计划批准即视为主管批准紧急调令：直接写加班申请（approved）并同步考勤，下班顺延，工资按 1.5× 在下班结算
            const reqId = Number(db.prepare(`INSERT INTO shift_requests
              (kind,staff_id,schedule_id,day,ot_ticks,reason,status,source,approver_id,create_tick,create_day,handle_tick,handle_note)
              VALUES('overtime',?,?,?,?,?, 'approved','dispatch',?,?,?, ?, '随跨日计划批准')`)
              .run(att.staff_id, att.schedule_id, att.day, it.ot_ticks,
                `跨日计划${plan.code}紧急调令：${it.demand_reason}`, approverId, ctx.tick(), ctx.day(), ctx.tick()).lastInsertRowid)
            const rcode = 'TB' + String(reqId).padStart(4, '0')
            db.prepare('UPDATE shift_requests SET code=? WHERE id=?').run(rcode, reqId)
            db.prepare('UPDATE staff_attendance SET ot_approved=1, overtime_ticks=overtime_ticks+? WHERE id=?').run(it.ot_ticks, att.id)
            db.prepare("UPDATE schedule_plan_items SET status='applied', result_request_id=? WHERE id=?").run(reqId, it.id)
            logShift({
              scheduleId: att.schedule_id, attendanceId: att.id, requestId: reqId, planId: plan.id, action: 'ot_approve',
              note: `跨日计划紧急调令批准：${getStaff(att.staff_id)?.name} 加班 ${it.ot_ticks}h（1.5 倍时薪）`, approverId
            })
            applied.push({ id: it.id, request_id: reqId })
            appliedOvertimes.push(reqId)
          }
        }
        // 按当时工资口径重算落地项预计工资（真实工资仍在下班结算时逐单入财务，保持工资口径一致）
        const appliedIds = new Set(applied.map(a => a.id))
        const realWage = items.filter(x => appliedIds.has(x.id))
          .reduce((s, x2) => s + (x2.action === 'add_overtime'
            ? estimateScheduleWage(x2.staff_id, x2.shift_id, x2.ot_ticks)
            : estimateScheduleWage(x2.staff_id, x2.shift_id)), 0)
        db.prepare(`UPDATE schedule_plans
           SET status='approved', approver_id=?, handle_tick=?, handle_day=?, handle_note=?, applied_count=?, skipped_count=?, est_wage=?
           WHERE id=?`)
          .run(approverId, ctx.tick(), ctx.day(), String(note || '主管批准').slice(0, 80), applied.length, skipped.length, realWage, planId)
        logPlan(planId, plan.code, 'plan_approve',
          `主管批准并原子落地：成功 ${applied.length} 项（补班 ${appliedSchedules.length}、调令 ${appliedOvertimes.length}），跳过 ${skipped.length} 项，预计新增工资 ¥${realWage}`,
          { approverId })
        return {
          ok: true, plan_id: planId, applied: applied.length, skipped: skipped.length,
          schedule_ids: appliedSchedules, request_ids: appliedOvertimes,
          skipped_detail: skipped, est_wage: realWage
        }
      })
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        // 单项唯一索引理论上已被前置校验拦截；兜底回滚整批，避免半落地
        return fail('SHIFT_CONFLICT', '落地时发现排班冲突，本次批准已整体回滚，请刷新计划后重试')
      }
      console.error('[scheduling] 批准跨日计划失败，已整体回滚:', e)
      return fail('TX_FAILED', '系统繁忙，计划未生效，请稍后重试')
    }
    // 提交后联动：按最新需求补缺（审批模式 → 生成新草案，不直接覆盖刚批准的排班）
    if (result?.ok) {
      try {
        if (num(getSetting('schedulePlanApproval'), 0)) {
          const follow = autoMaintainPlan('计划批准后残余缺口补缺')
          result.followup = follow
        } else {
          result.dispatch = runDynamicDispatch({ horizon: 3, urgentOvertime: true, reason: '计划批准后覆盖缺口补齐' })
        }
        const cov = coverageForDay(ctx.day())
        result.coverage = { warnings: cov.warnings.length, blocks: cov.warnings.filter(w => w.level === 'block').length }
      } catch (e) {
        console.error('[scheduling] 计划批准后联动补缺失败（不影响批准结果）:', e)
      }
    }
    return result
  })
}

// 驳回 / 废弃计划：无任何排班、考勤、工资副作用（草案从未落库）
function closePlan(planId, status, approverId, note) {
  return idempotent(status === 'rejected' ? 'schedule_plan_reject' : 'schedule_plan_cancel', '', () => {
    try {
      return tx(() => {
        const plan = db.prepare("SELECT * FROM schedule_plans WHERE id=?").get(planId)
        if (!plan) return fail('PLAN_NOT_FOUND', '跨日计划不存在')
        if (plan.status !== 'pending') return fail('PLAN_HANDLED', '该计划已处理')
        const applied = db.prepare("SELECT COUNT(*) n FROM schedule_plan_items WHERE plan_id=? AND status='applied'").get(planId).n
        if (applied > 0) return fail('PLAN_APPLIED', '计划已有落地项，不能驳回')
        db.prepare("UPDATE schedule_plan_items SET status='skipped', skip_reason=? WHERE plan_id=? AND status='pending'")
          .run(status === 'rejected' ? '主管驳回计划' : '计划废弃', planId)
        db.prepare("UPDATE schedule_plans SET status=?, approver_id=?, handle_tick=?, handle_day=?, handle_note=? WHERE id=?")
          .run(status, approverId, ctx.tick(), ctx.day(), String(note || '').slice(0, 80), planId)
        logPlan(planId, plan.code, status === 'rejected' ? 'plan_reject' : 'plan_cancel',
          `${status === 'rejected' ? '主管驳回' : '废弃'}跨日计划（草案未落排班，无工资影响）`, { approverId })
        return { ok: true }
      })
    } catch (e) {
      console.error('[scheduling] 计划处理失败，已回滚:', e)
      return fail('TX_FAILED', '系统繁忙，操作未生效，请稍后重试')
    }
  })
}
export function rejectSchedulePlan(planId, { approverId = null, note = '' } = {}) {
  return closePlan(planId, 'rejected', approverId, note || '主管驳回')
}
export function cancelSchedulePlan(planId, { note = '' } = {}) {
  return closePlan(planId, 'cancelled', null, note || '运营废弃计划')
}

// 计划明细装配（员工/班次名称、预计工资）
function enrichPlanItems(rows) {
  return rows.map(it => {
    const st = getStaff(it.staff_id)
    const sh = db.prepare('SELECT * FROM shift_templates WHERE id=?').get(it.shift_id)
    let refs = []
    try { refs = JSON.parse(it.refs_json || '[]') } catch { refs = [] }
    return {
      ...it,
      refs,
      staff_name: st?.name || '', staff_role: st?.role || '',
      shift_name: sh?.name || '', shift_code: sh?.code || '', shift_color: sh?.color || '#6dd5a0',
      cross_day_time: sh ? (sh.cross_day ? `${sh.start_hour}:00~次日${String(sh.end_hour).padStart(2, '0')}:00` : `${sh.start_hour}:00~${sh.end_hour}:00`) : ''
    }
  })
}

// 计划列表：status=pending 返回唯一待审批计划（含按日分组的预览与应用前后覆盖对比）；其余状态返回历史
export function listSchedulePlans({ status = 'all', limit = 30, withItems = true } = {}) {
  const rows = status === 'all'
    ? db.prepare('SELECT * FROM schedule_plans ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM schedule_plans WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
  return rows.map(p => {
    const items = withItems ? enrichPlanItems(db.prepare('SELECT * FROM schedule_plan_items WHERE plan_id=? ORDER BY id').all(p.id)) : []
    return { ...planPreview(p, items), items }
  })
}

// 计划预览：顶层保留扁平 items，另按日（dayGroups）× 班段汇总需求依据、拟派人员、预计工资，
// 以及计划落地前后岗位缺口（含跨日夜班）对比
function planPreview(plan, items) {
  const days = []
  for (let d = plan.day_from; d <= plan.day_to; d++) {
    const dayItems = items.filter(i => i.day === d)
    const virtual = dayItems.filter(i => i.action === 'add_schedule' && i.status === 'pending')
      .map(i => ({ virtual_id: i.id, staff_id: i.staff_id, shift_id: i.shift_id, day: i.day }))
    // 需求画像当天只算一次（客流/工单/投诉口径较重），before/after 缺口复用同一需求
    const dmd = demandForDay(d)
    const before = gapsForDay(d, { forDispatch: false, demand: dmd })
    const after = gapsForDay(d, { forDispatch: false, extras: virtual, demand: dmd })
    const bands = BANDS.map(b => {
      const ib = dayItems.filter(i => i.band === b.key)
      const bg = before.gaps.filter(g => g.band === b.key)
      const ag = after.gaps.filter(g => g.band === b.key)
      const gapN = arr => arr.reduce((s, g) => s + g.gap, 0)
      return {
        key: b.key, label: b.label,
        add_schedules: ib.filter(i => i.action === 'add_schedule').length,
        add_overtimes: ib.filter(i => i.action === 'add_overtime').length,
        gap_before: gapN(bg), gap_after: gapN(ag),
        hard_before: bg.some(g => g.hard) ? 1 : 0, hard_after: ag.some(g => g.hard) ? 1 : 0,
        est_wage: ib.reduce((s, i) => s + num(i.est_wage), 0)
      }
    })
    days.push({
      day: d,
      item_count: dayItems.length,
      bands,
      gap_total_before: before.gaps.reduce((s, g) => s + g.gap, 0),
      gap_total_after: after.gaps.reduce((s, g) => s + g.gap, 0),
      hard_before: before.gaps.some(g => g.hard) ? 1 : 0,
      hard_after: after.gaps.some(g => g.hard) ? 1 : 0,
      demand: {
        flowTotal: before.demand.flowTotal,
        openOrders: before.demand.openOrders,
        openComplaints: before.demand.openComplaints
      }
    })
  }
  return {
    ...plan,
    items,
    dayGroups: days,
    is_stale: planIsStale(plan),
    gap_before: days.reduce((s, x) => s + x.gap_total_before, 0),
    gap_after: days.reduce((s, x) => s + x.gap_total_after, 0),
    pending_items: items.filter(i => i.status === 'pending').length,
    applied_items: items.filter(i => i.status === 'applied').length,
    skipped_items: items.filter(i => i.status === 'skipped').length
  }
}

export function schedulePlanDetail(id) {
  const plan = db.prepare('SELECT * FROM schedule_plans WHERE id=?').get(id)
  if (!plan) return null
  const items = enrichPlanItems(db.prepare('SELECT * FROM schedule_plan_items WHERE plan_id=? ORDER BY id').all(id))
  return planPreview(plan, items)
}

// 当前待审批计划（无则 null）
export function currentPendingPlan() {
  const plan = db.prepare("SELECT * FROM schedule_plans WHERE status='pending' ORDER BY id DESC LIMIT 1").get()
  return plan ? schedulePlanDetail(plan.id) : null
}

// 未来 horizon 天动态调度计划（只读）：需求画像 + 当前覆盖缺口，供前端「动态调度」页展示
export function dispatchPlan({ horizon = 3 } = {}) {
  const today = ctx.day()
  const days = []
  for (let d = today; d <= today + horizon - 1; d++) {
    const cov = coverageForDay(d)
    days.push({ day: d, demand: cov.demand, warnings: cov.warnings, rosterCount: cov.rosterCount })
  }
  return {
    today,
    mode: getSetting('scheduleMode', 'dynamic'),
    autoFill: num(getSetting('scheduleAutoFill'), 1) ? 1 : 0,
    planApproval: num(getSetting('schedulePlanApproval'), 0) ? 1 : 0,
    params: {
      guardFlow: num(getSetting('dispatchGuardFlow'), 500),
      cleanFlow: num(getSetting('dispatchCleanFlow'), 700),
      nightGuardsPerZone: num(getSetting('dispatchNightGuardsPerZone'), 0)
    },
    days
  }
}
