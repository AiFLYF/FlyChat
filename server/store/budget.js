import { getDb } from './db.js'

/**
 * 成本预算（硬上限）。
 *
 * 调研 LibreChat / Open WebUI / AnythingLLM 时确认：三家都只能「事后看报表」，
 * 没有一个能在超支前把请求挡住。自托管用户最怕的就是「一夜之间烧掉几百美元」——
 * 所以这里做的是**事前拒绝**，不是事后统计。
 *
 * 0 = 不限制。
 */

const SCOPE = 'global'

export function getBudget() {
  const db = getDb()
  const row = db.prepare('SELECT * FROM budgets WHERE scope = ?').get(SCOPE)
  return {
    dailyUsd: row?.daily_usd ?? 0,
    monthlyUsd: row?.monthly_usd ?? 0,
    updatedAt: row?.updated_at ?? null,
    enabled: !!(row && (row.daily_usd > 0 || row.monthly_usd > 0)),
  }
}

export function setBudget({ dailyUsd = 0, monthlyUsd = 0 } = {}) {
  const db = getDb()
  const daily = Number.isFinite(Number(dailyUsd)) ? Math.max(0, Number(dailyUsd)) : 0
  const monthly = Number.isFinite(Number(monthlyUsd)) ? Math.max(0, Number(monthlyUsd)) : 0
  const now = Date.now()
  db.prepare(
    `INSERT INTO budgets (scope, daily_usd, monthly_usd, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET daily_usd = excluded.daily_usd, monthly_usd = excluded.monthly_usd, updated_at = excluded.updated_at`
  ).run(SCOPE, daily, monthly, now)
  return getBudget()
}

/** 本日 / 本月已花费（美元） */
export function spend() {
  const db = getDb()
  const daily =
    db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM usage_events
         WHERE strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') = strftime('%Y-%m-%d', 'now', 'localtime')`
      )
      .get()?.spent ?? 0
  const monthly =
    db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM usage_events
         WHERE strftime('%Y-%m', created_at / 1000, 'unixepoch', 'localtime') = strftime('%Y-%m', 'now', 'localtime')`
      )
      .get()?.spent ?? 0
  return { daily, monthly }
}

/**
 * 请求前检查。
 * 存储不可用时直接放行：预算是可选增强，绝不能让它把聊天/标题这类核心功能
 * 拖挂（与「记账失败静默」同一原则）。同理，调用方不需要包 try——这里不抛错。
 * @returns {{allowed: true, warn?: string} | {allowed: false, message: string, code: string}}
 */
export function checkBudget() {
  let budget
  try {
    budget = getBudget()
  } catch {
    return { allowed: true, budget: { enabled: false, dailyUsd: 0, monthlyUsd: 0 }, spend: { daily: 0, monthly: 0 } }
  }
  if (!budget.enabled) return { allowed: true, budget, spend: { daily: 0, monthly: 0 } }

  const spent = spend()
  if (budget.dailyUsd > 0 && spent.daily >= budget.dailyUsd) {
    return {
      allowed: false,
      code: 'daily_budget_exceeded',
      message: `本日成本已达上限 $${budget.dailyUsd.toFixed(2)}，为防止超额，请求已被拒绝。可在「设置 → 用量」里调整上限或等待明天。`,
      budget,
      spend: spent,
    }
  }
  if (budget.monthlyUsd > 0 && spent.monthly >= budget.monthlyUsd) {
    return {
      allowed: false,
      code: 'monthly_budget_exceeded',
      message: `本月成本已达上限 $${budget.monthlyUsd.toFixed(2)}，为防止超额，请求已被拒绝。可在「设置 → 用量」里调整上限或等待下月。`,
      budget,
      spend: spent,
    }
  }

  // 80% 软提示：不拦截，但让用户提前知道
  const nearDaily = budget.dailyUsd > 0 && spent.daily >= budget.dailyUsd * 0.8
  const nearMonthly = budget.monthlyUsd > 0 && spent.monthly >= budget.monthlyUsd * 0.8
  if (nearDaily || nearMonthly) {
    return {
      allowed: true,
      warn: `本${nearMonthly ? '月' : '日'}成本已用掉 ${nearMonthly ? Math.round((spent.monthly / budget.monthlyUsd) * 100) : Math.round((spent.daily / budget.dailyUsd) * 100)}%，快到设定的上限了。`,
      budget,
      spend: spent,
    }
  }

  return { allowed: true, budget, spend: spent }
}
