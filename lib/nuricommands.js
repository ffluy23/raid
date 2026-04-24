// lib/nuricommands.js
// raidBossAction.js executeBossAction 내부에서 누리레느 전용 커맨드 처리
// import해서 executeBossAction의 else-if 체인에 추가

import { josa } from "./effecthandler.js"
import { getTypeMultiplier } from "./typeChart.js"
import { bossMoves } from "./bossMoves.js"
import { moves } from "./moves.js"
import { rollD10 } from "./gameUtils.js"
import { getWeatherDamageMult } from "./weather.js"
import {
  PLAYER_SLOTS, makeLog, defaultRanks,
  getAlivePlayers, getActiveRankVal,
} from "./raidBossAction.js"

// ── 보스 데미지 계산 (raidBossAction 내부 로직과 동일) ────────────
function calcBossDmg(data, moveName, targetPkmn, diceOverride = null) {
  const moveInfo = bossMoves[moveName] ?? moves[moveName]
  if (!moveInfo) return { damage: 0, multiplier: 1, critical: false, dice: 0 }
  const dice     = diceOverride ?? rollD10()
  const defTypes = Array.isArray(targetPkmn.type) ? targetPkmn.type : [targetPkmn.type]
  let mult = 1
  for (const dt of defTypes) mult *= getTypeMultiplier(moveInfo.type, dt)
  if (mult === 0) return { damage: 0, multiplier: 0, critical: false, dice }
  const bossAtk  = (data.boss_attack ?? 5) + ((data.boss_rank?.atkTurns ?? 0) > 0 ? (data.boss_rank?.atk ?? 0) : 0)
  const defStat  = targetPkmn.defense ?? 3
  const defRank  = (targetPkmn.ranks?.defTurns ?? 0) > 0 ? (targetPkmn.ranks?.def ?? 0) : 0
  const power    = moveInfo.power ?? 40
  const weatherMult = getWeatherDamageMult(data.weather ?? null, moveInfo.type)
  const raw      = Math.floor((power + bossAtk * 4 + dice) * mult * weatherMult)
  const afterDef = Math.max(1, raw - defStat * 3 - defRank * 3)
  const lsMult   = (data.boss_lightScreen ?? 0) > 0 ? 0.75 : 1.0
  const after    = Math.floor(afterDef * lsMult)
  const critRate = Math.min(100, bossAtk * 2)
  const critical = Math.random() * 100 < critRate
  return { damage: critical ? Math.floor(after * 1.5) : after, multiplier: mult, critical, dice }
}

function applyDmgToPlayer(slot, dmg, entries, data, logEntries) {
  if (dmg <= 0) return
  const idx  = data[`${slot}_active_idx`] ?? 0
  const pkmn = entries[slot]?.[idx]
  if (!pkmn || pkmn.hp <= 0) return
  if (pkmn.defending) {
    logEntries.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 방어했다!`))
    pkmn.defending = false; pkmn.defendTurns = 0; return
  }
  if (pkmn.enduring && dmg >= pkmn.hp) {
    pkmn.hp = 1; pkmn.enduring = false
    logEntries.push(makeLog("after_hit", `${pkmn.name}${josa(pkmn.name, "은는")} 버텼다!`))
  } else {
    pkmn.hp = Math.max(0, pkmn.hp - dmg)
  }
  pkmn.tookDamageLastTurn = true
  pkmn.last_damage_taken  = dmg
  logEntries.push(makeLog("hit", "", { defender: slot }))
  logEntries.push(makeLog("hp",  "", { slot, hp: pkmn.hp, maxHp: pkmn.maxHp }))
  if (pkmn.hp <= 0)
    logEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot }))
}

// ── 딜 체크 로그 ─────────────────────────────────────────────────
function getDealCheckLog(ratio, charmedName) {
  if (ratio < 0.30) return "노래가 점점 깊어진다..."
  if (ratio < 0.60) return "노래가 흔들리기 시작한다!"
  if (ratio < 0.90) return [
    "누리레느의 노래가 크게 흔들린다!",
    `${charmedName}${josa(charmedName, "이가")} 정신을 되찾으려 한다!`,
  ]
  return "지금이다! 노래를 끊어!"
}

// ════════════════════════════════════════════════════════════════════
//  누리레느 전용 커맨드 처리 함수
//  executeBossAction 에서 호출: processNuriCommand(command, ...)
//  반환값: handled(bool), nextState(object|null)
// ════════════════════════════════════════════════════════════════════
export function processNuriCommand(command, decision, data, entries, logEntries) {
  const bossName = data.boss_name ?? "누리레느"
  const { targetSlot, moveLog, nextState: rawNextState } = decision
  let nextState = rawNextState ?? data.boss_state ?? {}

  // ── 차밍보이스 (유혹 부여) ────────────────────────────────────
  if (command === "nuri_charm") {
    if (moveLog) logEntries.push(makeLog("normal", moveLog))
    if (targetSlot) {
      const idx  = data[`${targetSlot}_active_idx`] ?? 0
      const pkmn = entries[targetSlot]?.[idx]
      if (pkmn && pkmn.hp > 0) {
        pkmn.seducedTurns = 3
        // 차밍보이스 자체에도 데미지가 있음 → 먼저 데미지 처리
        const dice = rollD10()
        const { damage, multiplier, critical } = calcBossDmg(data, "차밍보이스", pkmn, dice)
        logEntries.push(makeLog("dice", "", { slot: "boss", roll: dice }))
        if (multiplier !== 0 && damage > 0) {
          applyDmgToPlayer(targetSlot, damage, entries, data, logEntries)
          if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
          if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
        }
        logEntries.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 유혹 상태가 됐다!`))
      }
    }
    return { handled: true, nextState }
  }

  // ── 헤롱헤롱 (2페이즈 완전 행동불가) ─────────────────────────
  if (command === "nuri_charm2") {
    if (moveLog) logEntries.push(makeLog("normal", moveLog))
    if (targetSlot) {
      const idx  = data[`${targetSlot}_active_idx`] ?? 0
      const pkmn = entries[targetSlot]?.[idx]
      if (pkmn && pkmn.hp > 0) {
        pkmn.charmed = true
        logEntries.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 헤롱헤롱 상태가 됐다!`))
      }
    }
    return { handled: true, nextState }
  }

  // ── 파도타기 약화 (80%) ───────────────────────────────────────
  if (command === "nuri_wave_weak") {
    logEntries.push(makeLog("move_announce", `${bossName}${josa(bossName, "의")} 파도타기!`))
    const alive = getAlivePlayers(data, entries)
    const dice  = rollD10()
    for (const s of alive) {
      const idx  = data[`${s}_active_idx`] ?? 0
      const pkmn = entries[s]?.[idx]
      if (!pkmn || pkmn.hp <= 0) continue
      const { damage, multiplier, critical } = calcBossDmg(data, "파도타기", pkmn, dice)
      if (multiplier === 0) { logEntries.push(makeLog("normal", `${pkmn.name}에게는 효과가 없다…`)); continue }
      const weakDmg = Math.max(1, Math.floor(damage * 0.80))
      applyDmgToPlayer(s, weakDmg, entries, data, logEntries)
      if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
      if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
    }
    return { handled: true, nextState }
  }

  // ── 파도타기 풀데미지 (100%) ──────────────────────────────────
  if (command === "nuri_wave_full") {
    logEntries.push(makeLog("move_announce", `${bossName}${josa(bossName, "의")} 파도타기!`))
    const alive = getAlivePlayers(data, entries)
    const dice  = rollD10()
    for (const s of alive) {
      const idx  = data[`${s}_active_idx`] ?? 0
      const pkmn = entries[s]?.[idx]
      if (!pkmn || pkmn.hp <= 0) continue
      const { damage, multiplier, critical } = calcBossDmg(data, "파도타기", pkmn, dice)
      if (multiplier === 0) { logEntries.push(makeLog("normal", `${pkmn.name}에게는 효과가 없다…`)); continue }
      applyDmgToPlayer(s, Math.max(1, damage), entries, data, logEntries)
      if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
      if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
    }
    return { handled: true, nextState }
  }

  // ── 딜 체크 + 문포스 결과 ────────────────────────────────────
  if (command === "nuri_deal_check") {
    const charmedSlot = data.boss_state?.charmedSlot ?? null
    const charmedIdx  = charmedSlot ? (data[`${charmedSlot}_active_idx`] ?? 0) : null
    const charmedPkmn = charmedSlot ? entries[charmedSlot]?.[charmedIdx] : null
    const charmedName = charmedPkmn?.name ?? "???"

    const accumulated = data.boss_state?.dealCheckDmg ?? 0
    const threshold   = 450
    const ratio       = Math.min(1, accumulated / threshold)

    // 딜 체크 로그
    const checkLog = getDealCheckLog(ratio, charmedName)
    if (Array.isArray(checkLog)) {
      checkLog.forEach(l => logEntries.push(makeLog("normal", l)))
    } else {
      logEntries.push(makeLog("normal", checkLog))
    }

    const alive = getAlivePlayers(data, entries)

    if (accumulated >= threshold) {
      // 성공: 광역 문포스 75% 경감
      logEntries.push(makeLog("normal", "누리레느가 분노했다!"))
      logEntries.push(makeLog("move_announce", `${bossName}${josa(bossName, "의")} 문포스!`))
      const dice = rollD10()
      for (const s of alive) {
        const idx  = data[`${s}_active_idx`] ?? 0
        const pkmn = entries[s]?.[idx]
        if (!pkmn || pkmn.hp <= 0) continue
        const { damage, multiplier, critical } = calcBossDmg(data, "문포스", pkmn, dice)
        if (multiplier === 0) { logEntries.push(makeLog("normal", `${pkmn.name}에게는 효과가 없다…`)); continue }
        const reducedDmg = Math.max(1, Math.floor(damage * 0.25))
        applyDmgToPlayer(s, reducedDmg, entries, data, logEntries)
        if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
        if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
      }
      // 헤롱헤롱 해제
      if (charmedPkmn) {
        charmedPkmn.charmed = false
        logEntries.push(makeLog("normal", `${charmedName}${josa(charmedName, "은는")} 정신을 차렸다!`))
      }
    } else {
      // 실패: 헤롱헤롱 대상에게 단일 문포스 (경감 없음)
      logEntries.push(makeLog("normal", "누리레느가 웃고 있다..."))
      if (charmedSlot && charmedPkmn && charmedPkmn.hp > 0) {
        logEntries.push(makeLog("move_announce", `${bossName}${josa(bossName, "의")} 문포스!`))
        const { damage, multiplier, critical } = calcBossDmg(data, "문포스", charmedPkmn)
        if (multiplier !== 0) {
          applyDmgToPlayer(charmedSlot, Math.max(1, damage), entries, data, logEntries)
          if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
          if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
        }
      }
      // 헤롱헤롱 지속 (풀리지 않음)
      if (charmedPkmn) {
        logEntries.push(makeLog("normal", `${charmedName}${josa(charmedName, "은는")} 아직 헤롱헤롱 상태다...`))
      }
    }

    return { handled: true, nextState }
  }

  // ── 파도 예고 ─────────────────────────────────────────────────
  if (command === "wave_warning") {
    // log는 executeBossAction에서 commandLog로 이미 출력됨
    return { handled: true, nextState }
  }

  return { handled: false, nextState }
}