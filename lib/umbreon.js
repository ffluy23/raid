// lib/umbreon.js
// 블래키 보호 시스템
// 조건: 세 플레이어 중 한 명이라도 마지막 포켓몬 + HP 40% 이하일 때
//       보스 공격을 완전히 차단하고 받은 피해 × 2로 보복 후 사라짐
// 게임당 딱 한 번만 발동

import { josa } from "./effecthandler.js"

// raidBossAction.js 순환 import 방지 — 직접 정의
const PLAYER_SLOTS = ["p1", "p2", "p3"]

function makeLog(type, text = "", meta = null) {
  return { type, text, ...(meta ? { meta } : {}) }
}

const UMBREON_HP_THRESHOLD = 0.4  // 40% 이하
const UMBREON_REVENGE_MULT = 2    // 보복 배율

export function activateUmbreon(damages, data, entries, logEntries) {
  if (data.umbreon_used) return { activated: false }

  let triggerSlot   = null
  let blockedDamage = 0

  for (const [slot, dmg] of Object.entries(damages)) {
    if (dmg <= 0) continue
    const entry      = entries[slot] ?? []
    const activeIdx  = data[`${slot}_active_idx`] ?? 0
    const activePkmn = entry[activeIdx]
    if (!activePkmn || activePkmn.hp <= 0) continue
    const hasBackup = entry.some((p, i) => i !== activeIdx && p.hp > 0)
    if (hasBackup) continue
    const hpRatio = activePkmn.hp / (activePkmn.maxHp ?? activePkmn.hp)
    if (hpRatio > UMBREON_HP_THRESHOLD) continue
    triggerSlot   = slot
    blockedDamage = dmg
    break
  }

  if (!triggerSlot) return { activated: false }

  const protectedPkmn = entries[triggerSlot]?.[data[`${triggerSlot}_active_idx`] ?? 0]
  const protectedName = protectedPkmn?.name ?? "포켓몬"
  const bossName      = data.boss_name ?? "보스"

  logEntries.push(makeLog("umbreon", ""))
  logEntries.push(makeLog("normal", `어디선가 블래키가 나타났다!`))
  logEntries.push(makeLog("normal", `블래키${josa("블래키", "이가")} ${protectedName}${josa(protectedName, "을를")} 감쌌다!`))

  damages[triggerSlot] = 0

  const finalRevenge = Math.max(1, blockedDamage * UMBREON_REVENGE_MULT)

  logEntries.push(makeLog("move_announce", `블래키의 보복!`))
  logEntries.push(makeLog("hit", "", { defender: "boss" }))

  data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - finalRevenge)

  logEntries.push(makeLog("hp", "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
  logEntries.push(makeLog("after_hit", `${finalRevenge} 데미지!`))

  if (data.boss_current_hp <= 0)
    logEntries.push(makeLog("faint", `${bossName}${josa(bossName, "은는")} 쓰러졌다!`, { slot: "boss" }))

  logEntries.push(makeLog("normal", `블래키는 어둠 속으로 사라졌다…`))

  data.umbreon_used = true

  return { activated: true }
}