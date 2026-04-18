// api/raidBossTurn.js
import { db } from "../lib/firestore.js"
import { bossMoves } from "../lib/bossMoves.js"
import { moves } from "../lib/moves.js"
import { getTypeMultiplier } from "../lib/typeChart.js"
import { josa } from "../lib/effecthandler.js"
import { corsHeaders, rollD10 } from "../lib/gameUtils.js"
import { getBossAI } from "../lib/bossRegistry.js"

const PLAYER_SLOTS = ["p1", "p2", "p3"]

function makeLog(type, text = "", meta = null) {
  return { type, text, ...(meta ? { meta } : {}) }
}

async function writeLogs(roomId, logEntries) {
  const logsRef = db.collection("raid").doc(roomId).collection("logs")
  const base    = Date.now()
  const batch   = db.batch()
  logEntries.forEach((entry, i) => batch.set(logsRef.doc(), { ...entry, ts: base + i }))
  await batch.commit()
}

function defaultRanks() {
  return { atk: 0, atkTurns: 0, def: 0, defTurns: 0, spd: 0, spdTurns: 0 }
}

function getActiveRankVal(ranks, key) {
  return (ranks?.[`${key}Turns`] ?? 0) > 0 ? (ranks?.[key] ?? 0) : 0
}

function deepCopyEntries(data) {
  const entries = {}
  PLAYER_SLOTS.forEach(s => {
    entries[s] = JSON.parse(JSON.stringify(data[`${s}_entry`] ?? []))
  })
  return entries
}

function buildEntryUpdate(entries) {
  const update = {}
  PLAYER_SLOTS.forEach(s => { update[`${s}_entry`] = entries[s] })
  return update
}

function getAlivePlayers(data, entries) {
  return PLAYER_SLOTS.filter(s => {
    const idx  = data[`${s}_active_idx`] ?? 0
    const pkmn = entries[s]?.[idx]
    return pkmn && pkmn.hp > 0
  })
}

function checkRaidWin(entries, bossHp) {
  if (bossHp <= 0) return "victory"
  const allDead = PLAYER_SLOTS.every(s => (entries[s] ?? []).every(p => p.hp <= 0))
  if (allDead) return "defeat"
  return null
}

// ── 보스 공격력/방어력 계산 ──────────────────────────────────────────
function getBossAtk(data) {
  const base = data.boss_attack ?? 5
  const rank = getActiveRankVal(data.boss_rank, "atk")
  return base + rank
}

// ── 데미지 계산 (보스 → 플레이어) ───────────────────────────────────
function calcBossDamage(data, moveName, targetPkmn, diceOverride = null) {
  const moveInfo = bossMoves[moveName] ?? moves[moveName]
  if (!moveInfo) return { damage: 0, multiplier: 1, critical: false, dice: 0 }

  const dice     = diceOverride ?? rollD10()
  const defTypes = Array.isArray(targetPkmn.type) ? targetPkmn.type : [targetPkmn.type]
  let mult = 1
  for (const dt of defTypes) mult *= getTypeMultiplier(moveInfo.type, dt)
  if (mult === 0) return { damage: 0, multiplier: 0, critical: false, dice }

  const bossAtk  = getBossAtk(data)
  const defStat  = targetPkmn.defense ?? 3
  const defRank  = getActiveRankVal(targetPkmn.ranks, "def")
  const power    = moveInfo.power ?? 40
  const base     = power + bossAtk * 4 + dice
  const raw      = Math.floor(base * mult)
  const afterDef = Math.max(1, raw - defStat * 3 - defRank * 3)

  const critRate = Math.min(100, bossAtk * 2)
  const critical = Math.random() * 100 < critRate
  const damage   = critical ? Math.floor(afterDef * 1.5) : afterDef

  return { damage, multiplier: mult, critical, dice }
}

// ── 싱크로 분산 ──────────────────────────────────────────────────────
function applySyncDistribution(rawDamage, targetSlot, data, entries, logEntries) {
  if (!data.sync_active) return { damages: { [targetSlot]: rawDamage }, clearSync: false }

  const alivePlayers = getAlivePlayers(data, entries)
  if (alivePlayers.length <= 1) {
    return { damages: { [targetSlot]: rawDamage }, clearSync: true }
  }

  const share   = Math.max(1, Math.floor(rawDamage / alivePlayers.length))
  const damages = {}
  alivePlayers.forEach(s => { damages[s] = share })

  logEntries.push(makeLog("sync", ""))
  logEntries.push(makeLog("after_hit",
    `💠 싱크로나이즈! ${alivePlayers.length}명이 데미지를 균등 분산! (각 ${share})`
  ))

  return { damages, clearSync: true }
}

// ── 플레이어들에게 데미지 적용 ───────────────────────────────────────
function applyDamagesToPlayers(damages, entries, data, logEntries) {
  for (const [slot, dmg] of Object.entries(damages)) {
    const idx  = data[`${slot}_active_idx`] ?? 0
    const pkmn = entries[slot]?.[idx]
    if (!pkmn || pkmn.hp <= 0) continue
    if (pkmn.enduring && dmg >= pkmn.hp) {
      pkmn.hp      = 1
      pkmn.enduring = false
      logEntries.push(makeLog("after_hit", `${pkmn.name}${josa(pkmn.name, "은는")} 버텼다!`))
    } else {
      pkmn.hp = Math.max(0, pkmn.hp - dmg)
    }
    // 방어 상태 해제
    pkmn.defending   = false
    pkmn.defendTurns = 0

    logEntries.push(makeLog("hit", "", { defender: slot }))
    logEntries.push(makeLog("hp",  "", { slot, hp: pkmn.hp, maxHp: pkmn.maxHp }))
    if (pkmn.hp <= 0) logEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot }))
    if (pkmn.bideState) {
      pkmn.bideState.damage = (pkmn.bideState.damage ?? 0) + dmg
      pkmn.bideState.lastAttackerSlot = "boss"
    }
  }
}

// ── 단일/광역 공격 처리 ──────────────────────────────────────────────
function processBossAttack(moveName, targetSlot, isAoe, data, entries, logEntries, bossName) {
  const moveInfo = bossMoves[moveName] ?? moves[moveName]
  const dice     = rollD10()

  logEntries.push(makeLog("move_announce", `${bossName}의 ${moveName}!`))

  if (isAoe) {
    // 광역 — 전원에게 같은 주사위로 데미지
    const alive = getAlivePlayers(data, entries)
    if (alive.length === 0) {
      logEntries.push(makeLog("normal", "공격할 대상이 없다!"))
      return
    }
    for (const slot of alive) {
      const idx  = data[`${slot}_active_idx`] ?? 0
      const pkmn = entries[slot]?.[idx]
      if (!pkmn || pkmn.hp <= 0) continue
      const { damage, multiplier, critical } = calcBossDamage(data, moveName, pkmn, dice)
      if (multiplier === 0) {
        logEntries.push(makeLog("normal", `${pkmn.name}에게는 효과가 없다…`))
        continue
      }
      logEntries.push(makeLog("hit", "", { defender: slot }))
      if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
      if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
      if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
      if (pkmn.enduring && damage >= pkmn.hp) {
        pkmn.hp      = 1
        pkmn.enduring = false
        logEntries.push(makeLog("after_hit", `${pkmn.name}${josa(pkmn.name, "은는")} 버텼다!`))
      } else {
        pkmn.hp = Math.max(0, pkmn.hp - damage)
      }
      pkmn.defending   = false
      pkmn.defendTurns = 0
      logEntries.push(makeLog("hp", "", { slot, hp: pkmn.hp, maxHp: pkmn.maxHp }))
      if (pkmn.hp <= 0) logEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot }))
      if (pkmn.bideState) {
        pkmn.bideState.damage = (pkmn.bideState.damage ?? 0) + damage
        pkmn.bideState.lastAttackerSlot = "boss"
      }
    }
    // 광역은 싱크로 미적용
  } else {
    // 단일
    if (!targetSlot) {
      logEntries.push(makeLog("normal", "공격할 대상이 없다!"))
      return
    }
    const idx  = data[`${targetSlot}_active_idx`] ?? 0
    const pkmn = entries[targetSlot]?.[idx]
    if (!pkmn || pkmn.hp <= 0) {
      logEntries.push(makeLog("normal", "공격할 대상이 이미 쓰러졌다!"))
      return
    }

    const { damage, multiplier, critical } = calcBossDamage(data, moveName, pkmn, dice)
    logEntries.push(makeLog("dice", "", { slot: "boss", roll: dice }))

    if (multiplier === 0) {
      logEntries.push(makeLog("normal", `${pkmn.name}에게는 효과가 없다…`))
      return
    }

    if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
    if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
    if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))

    // 싱크로 분산 체크
    const { damages, clearSync } = applySyncDistribution(damage, targetSlot, data, entries, logEntries)
    applyDamagesToPlayers(damages, entries, data, logEntries)
    if (clearSync) data.sync_active = false

    // 이동 효과 (랭크 등)
    if (moveInfo?.rank?.targetDef !== undefined) {
      const pkmn2 = entries[targetSlot]?.[data[`${targetSlot}_active_idx`] ?? 0]
      if (pkmn2 && pkmn2.hp > 0) {
        const chance = moveInfo.rank.chance ?? 1
        if (Math.random() < chance) {
          const r    = pkmn2.ranks ?? defaultRanks()
          const cur  = r.def ?? 0
          const next = Math.max(-3, cur + moveInfo.rank.targetDef)
          pkmn2.ranks = { ...r, def: next, defTurns: next !== cur ? (moveInfo.rank.turns ?? 2) : r.defTurns }
          if (next < cur) logEntries.push(makeLog("normal", `${pkmn2.name}${josa(pkmn2.name, "의")} 방어 랭크가 내려갔다!`))
        }
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════
//  메인 핸들러
// ════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).end()

  const { roomId } = req.body
  if (!roomId) return res.status(400).json({ error: "roomId 필요" })

  const roomRef = db.collection("raid").doc(roomId)
  const snap    = await roomRef.get()
  const data    = snap.data()

  if (!data)             return res.status(404).json({ error: "방 없음" })
  if (!data.game_started) return res.status(403).json({ error: "게임 시작 전" })
  if (data.game_over)    return res.status(403).json({ error: "게임 종료" })
  if ((data.current_order ?? [])[0] !== "boss")
    return res.status(403).json({ error: "보스 턴이 아님" })

  const entries  = deepCopyEntries(data)
  const bossName = data.boss_name ?? "보스"

  // 보스 AI 동적 로드
  let bossAI
  try {
    bossAI = getBossAI(bossName)
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
  const { decideBossMove, shouldTriggerUlt, getUltTarget, nextUltCooldown } = bossAI
  const logEntries = []

  // ── 기습 ult 먼저 체크 (2페이즈, 쿨다운 0) ──────────────────────
  let syncActiveAfter    = data.sync_active ?? false
  let bossUltCooldownNext = data.boss_ult_cooldown ?? 0

  if (shouldTriggerUlt(data)) {
    const ultTarget = getUltTarget(data, entries, PLAYER_SLOTS)
    if (ultTarget) {
      logEntries.push(makeLog("normal", `${bossName}이(가) 기습을 노린다!`))
      processBossAttack("기습", ultTarget, false, data, entries, logEntries, bossName)
      bossUltCooldownNext = nextUltCooldown()
      syncActiveAfter = data.sync_active  // applySyncDistribution이 data.sync_active 수정
    }
  }

  // ── 일반 행동 ───────────────────────────────────────────────────
  const { moveName, targetSlot, nextState } = decideBossMove(data, entries, PLAYER_SLOTS)
  const moveInfo = bossMoves[moveName] ?? moves[moveName]
  const isAoe    = !!(moveInfo?.aoe)

  // 보스 상태이상 체크 (마비/얼음)
  if (data.boss_status === "마비" && Math.random() < 0.25) {
    logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} 마비로 움직일 수 없다!`))
  } else if (data.boss_status === "얼음" && Math.random() < 0.2) {
    logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} 얼어붙어 있다!`))
    // 20% 확률로 녹음
    if (Math.random() < 0.2) {
      logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} 얼음이 녹았다!`))
      data.boss_status = null
    }
  } else {
    // 정상 행동
    processBossAttack(moveName, targetSlot, isAoe, data, entries, logEntries, bossName)

    // 보스 상태이상 EOT (독/화상)
    if (data.boss_status === "독") {
      const dmg = Math.max(1, Math.floor((data.boss_max_hp ?? 1) / 16))
      data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - dmg)
      logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} 독 데미지로 ${dmg} HP를 잃었다!`))
      logEntries.push(makeLog("hp", "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
    } else if (data.boss_status === "화상") {
      const dmg = Math.max(1, Math.floor((data.boss_max_hp ?? 1) / 16))
      data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - dmg)
      logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} 화상 데미지로 ${dmg} HP를 잃었다!`))
      logEntries.push(makeLog("hp", "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
    }
  }

  // ── 보스 last_attacker 업데이트 추적용 필드 유지 ────────────────
  // (raidUseMove에서 플레이어가 공격 시 boss_last_attacker, boss_damage_taken 업데이트)

  // ── 승패 판정 ────────────────────────────────────────────────────
  const result = checkRaidWin(entries, data.boss_current_hp ?? 0)

  // ── 로그 작성 ────────────────────────────────────────────────────
  await writeLogs(roomId, logEntries)

  // ── Firestore 업데이트 ───────────────────────────────────────────
  const newOrder = (data.current_order ?? []).slice(1)
  const update   = {
    ...buildEntryUpdate(entries),
    boss_current_hp:  data.boss_current_hp ?? 0,
    boss_status:      data.boss_status     ?? null,
    boss_rank:        data.boss_rank       ?? defaultRanks(),
    boss_volatile:    data.boss_volatile   ?? {},
    boss_state:       nextState,
    boss_last_move:   moveName,
    boss_ult_cooldown: bossUltCooldownNext,
    sync_active:      data.sync_active ?? false,
    current_order:    newOrder,
    turn_count:       (data.turn_count ?? 1) + 1,
    turn_started_at:  newOrder.length > 0 ? Date.now() : null,
  }

  PLAYER_SLOTS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined) update[`${s}_active_idx`] = data[`${s}_active_idx`]
  })

  if (result) {
    update.game_over     = true
    update.raid_result   = result
    update.current_order = []
    update.turn_started_at = null
  }

  await roomRef.update(update)
  return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
}