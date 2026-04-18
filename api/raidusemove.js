// api/raidUseMove.js
import { db } from "../lib/firestore.js"
import { executeBossAction, deepCopyEntries as deepCopyRaidEntries2, checkRaidWin as checkRaidWin2, PLAYER_SLOTS as PS } from "../lib/raidBossAction.js"
import { moves } from "../lib/moves.js"
import { getTypeMultiplier } from "../lib/typeChart.js"
import {
  josa, applyMoveEffect, checkPreActionStatus,
  checkConfusion, applyEndOfTurnDamage, getStatusSpdPenalty,
  applyStatus, applyVolatile, tickVolatiles
} from "../lib/effecthandler.js"
import {
  deepCopyEntries, corsHeaders, rollD10, getActiveRank,
  patchMoveForWeather
} from "../lib/gameUtils.js"

// ── 레이드 상수 ──────────────────────────────────────────────────────
const PLAYER_SLOTS = ["p1", "p2", "p3"]

function makeLog(type, text = "", meta = null) {
  return { type, text, ...(meta ? { meta } : {}) }
}

async function writeLogs(roomId, logEntries) {
  const logsRef = db.collection("raid").doc(roomId).collection("logs")
  const base    = Date.now()
  const batch   = db.batch()
  let assistEventTs = null, syncEventTs = null
  logEntries.forEach((entry, i) => {
    const ts = base + i
    if (entry.type === "assist") assistEventTs = ts
    if (entry.type === "sync")   syncEventTs   = ts
    batch.set(logsRef.doc(), { ...entry, ts })
  })
  await batch.commit()
  return { assistEventTs, syncEventTs }
}

function defaultRanks() {
  return { atk: 0, atkTurns: 0, def: 0, defTurns: 0, spd: 0, spdTurns: 0 }
}

function getActiveRankVal(pokemon, key) {
  const r = pokemon.ranks ?? {}
  return (r[`${key}Turns`] ?? 0) > 0 ? (r[key] ?? 0) : 0
}

function getBaseStat(pokemon, key) {
  return pokemon[key === "atk" ? "attack" : key === "def" ? "defense" : "speed"] ?? 3
}

// ── 승패 판정 ────────────────────────────────────────────────────────
// 보스 HP 0 → 플레이어 승리 / 플레이어 전원 기절 → 패배
function checkRaidWin(entries, bossHp) {
  if (bossHp <= 0) return "victory"
  const allDead = PLAYER_SLOTS.every(s => (entries[s] ?? []).every(p => p.hp <= 0))
  if (allDead) return "defeat"
  return null
}

// ── 플레이어 엔트리 deep copy ────────────────────────────────────────
function deepCopyRaidEntries(data) {
  const entries = {}
  PLAYER_SLOTS.forEach(s => {
    entries[s] = JSON.parse(JSON.stringify(data[`${s}_entry`] ?? []))
  })
  return entries
}

function buildRaidEntryUpdate(entries) {
  const update = {}
  PLAYER_SLOTS.forEach(s => { update[`${s}_entry`] = entries[s] })
  return update
}

// ── 랭크 ────────────────────────────────────────────────────────────
function tickRanks(pokemon, logEntries) {
  if (!pokemon.ranks) return
  const r = pokemon.ranks
  if (r.atkTurns > 0) { r.atkTurns--; if (!r.atkTurns) { r.atk = 0; logEntries.push(makeLog("normal", `${pokemon.name}의 공격 랭크가 원래대로 돌아왔다!`)) } }
  if (r.defTurns > 0) { r.defTurns--; if (!r.defTurns) { r.def = 0; logEntries.push(makeLog("normal", `${pokemon.name}의 방어 랭크가 원래대로 돌아왔다!`)) } }
  if (r.spdTurns > 0) { r.spdTurns--; if (!r.spdTurns) { r.spd = 0; logEntries.push(makeLog("normal", `${pokemon.name}의 스피드 랭크가 원래대로 돌아왔다!`)) } }
}

function applyRankChanges(r, self, target, moveName, logEntries) {
  if (!r) return
  const roll = r.chance !== undefined ? Math.random() < r.chance : true
  if (!roll) return
  const selfR   = { ...(self.ranks   ?? defaultRanks()) }
  const targetR = { ...(target.ranks ?? defaultRanks()) }

  const ATK_MAX = 4, DEF_MAX = 3, SPD_MAX = 5
  function applyOne(obj, key, delta, name) {
    const label  = key === "atk" ? "공격" : key === "def" ? "방어" : "스피드"
    const maxVal = key === "atk" ? ATK_MAX : key === "def" ? DEF_MAX : SPD_MAX
    const cur    = obj[key] ?? 0
    if (delta > 0) {
      if (cur >= maxVal) { logEntries.push(makeLog("normal", `${name}의 ${label} 랭크는 이미 최대다!`)); return }
      const next = Math.min(maxVal, cur + delta)
      obj[key] = next
      if ((obj[`${key}Turns`] ?? 0) <= 0) obj[`${key}Turns`] = r.turns ?? 2
      logEntries.push(makeLog("normal", `${name}의 ${label} 랭크가 ${next - cur} 올라갔다! (${next > 0 ? "+" : ""}${next})`))
    } else if (delta < 0) {
      const minVal = -maxVal
      if (cur <= minVal) { logEntries.push(makeLog("normal", `${name}의 ${label} 랭크는 더 이상 내려가지 않는다!`)); return }
      const next = Math.max(minVal, cur + delta)
      obj[key] = next
      if ((obj[`${key}Turns`] ?? 0) <= 0) obj[`${key}Turns`] = r.turns ?? 2
      logEntries.push(makeLog("normal", `${name}의 ${label} 랭크가 ${cur - next} 내려갔다! (${next > 0 ? "+" : ""}${next})`))
    }
  }
  if (r.atk       !== undefined) applyOne(selfR,   "atk", r.atk,       self.name)
  if (r.def       !== undefined) applyOne(selfR,   "def", r.def,       self.name)
  if (r.spd       !== undefined) applyOne(selfR,   "spd", r.spd,       self.name)
  if (r.targetAtk !== undefined) applyOne(targetR, "atk", r.targetAtk, target.name)
  if (r.targetDef !== undefined) applyOne(targetR, "def", r.targetDef, target.name)
  if (r.targetSpd !== undefined) applyOne(targetR, "spd", r.targetSpd, target.name)
  self.ranks   = selfR
  target.ranks = targetR
}

// ── 명중 계산 ────────────────────────────────────────────────────────
function calcHit(atk, moveInfo, def) {
  if (Math.random() * 100 >= (moveInfo.accuracy ?? 100)) return { hit: false, hitType: "missed" }
  if (def.flyState?.flying  && !moveInfo.twister) return { hit: false, hitType: "evaded" }
  if (def.digState?.digging && moveInfo._name !== "지진") return { hit: false, hitType: "evaded" }
  if (def.ghostDiveState?.diving) return { hit: false, hitType: "evaded" }
  if (moveInfo.alwaysHit || moveInfo.skipEvasion) return { hit: true, hitType: "hit" }
  const as = Math.max(1, getBaseStat(atk, "spd") - getStatusSpdPenalty(atk))
  const ds = Math.max(1, getBaseStat(def, "spd") - getStatusSpdPenalty(def))
  const atkSpdRank = getActiveRankVal(atk, "spd")
  const defSpdRank = getActiveRankVal(def, "spd")
  const ev = Math.min(99, Math.max(0, 5 * (ds - as) + (defSpdRank - atkSpdRank)))
  return Math.random() * 100 < ev ? { hit: false, hitType: "evaded" } : { hit: true, hitType: "hit" }
}

// ── 데미지 계산 ──────────────────────────────────────────────────────
function calcDamage(atk, moveName, def, powerOverride = null, diceOverride = null) {
  const move = moves[moveName]
  if (!move) return { damage: 0, multiplier: 1, stab: false, critical: false, dice: 0 }
  const dice     = diceOverride ?? rollD10()
  const defTypes = Array.isArray(def.type) ? def.type : [def.type]
  let mult = 1
  for (const dt of defTypes) mult *= getTypeMultiplier(move.type, dt)
  if (mult === 0) return { damage: 0, multiplier: 0, stab: false, critical: false, dice }
  const atkTypes = Array.isArray(atk.type) ? atk.type : [atk.type]
  const stab     = atkTypes.includes(move.type)
  const power    = powerOverride ?? (move.power ?? 40)
  const atkStat  = getBaseStat(atk, "atk")
  const base     = power + atkStat * 4 + dice
  const raw      = Math.floor(base * mult * (stab ? 1.3 : 1))
  const atkRank  = getActiveRankVal(atk, "atk")
  const afterAtk = Math.max(0, raw + atkRank)
  const afterDef = afterAtk - getBaseStat(def, "def") * 3
  const defRank  = getActiveRankVal(def, "def")
  const baseDmg  = afterDef - defRank * 3
  if (baseDmg <= 0) {
    const minDice   = Math.floor(Math.random() * 5) + 1
    const minDamage = minDice * 5
    return { damage: minDamage, multiplier: mult, stab, critical: false, dice, minRoll: true, minDice }
  }
  const critRate = Math.min(100, atkStat * 2 + (move.highCrit ? 3 : 0))
  const critical = Math.random() * 100 < critRate
  return { damage: critical ? Math.floor(baseDmg * 1.5) : baseDmg, multiplier: mult, stab, critical, dice }
}

// ── 싱크로나이즈 데미지 분산 ─────────────────────────────────────────
// 보스가 플레이어를 공격할 때 호출
// sync_active: true이면 살아있는 플레이어 수로 균등 분산
function applySyncDistribution(rawDamage, targetSlot, entries, data, logEntries) {
  const syncActive = data.sync_active ?? false
  if (!syncActive) return { distributed: false, damages: { [targetSlot]: rawDamage } }

  // 살아있는 플레이어 슬롯
  const alivePlayers = PLAYER_SLOTS.filter(s => {
    const idx = data[`${s}_active_idx`] ?? 0
    const p   = entries[s]?.[idx]
    return p && p.hp > 0
  })

  if (alivePlayers.length <= 1) {
    // 1명만 살아있으면 분산 불가 → 싱크 해제
    return { distributed: false, damages: { [targetSlot]: rawDamage }, clearSync: true }
  }

  const share  = Math.max(1, Math.floor(rawDamage / alivePlayers.length))
  const damages = {}
  alivePlayers.forEach(s => { damages[s] = share })

  logEntries.push(makeLog("sync", ""))
  logEntries.push(makeLog("after_hit",
    `💠 싱크로나이즈! ${alivePlayers.length}명이 데미지를 균등 분산! (각 ${share})`
  ))

  return { distributed: true, damages, clearSync: true }
}

// ── 2턴 기술 공통 처리 ───────────────────────────────────────────────
function handleTwoTurnAttack(myPkmn, mySlot, targetSlot, entries, data, logEntries, opts = {}) {
  const { moveName, accuracy, isBoss } = opts

  if (isBoss) {
    // 보스 → 플레이어 공격
    const tIdx  = data[`${targetSlot}_active_idx`] ?? 0
    const tPkmn = entries[targetSlot]?.[tIdx]
    if (!tPkmn || tPkmn.hp <= 0) { logEntries.push(makeLog("normal", "상대가 이미 쓰러졌다!")); return }
    const { hit, hitType } = calcHit(myPkmn, { accuracy: accuracy ?? 95 }, tPkmn)
    if (!hit) { logEntries.push(makeLog("normal", hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : "빗나갔다!")); return }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return }
    const { distributed, damages, clearSync } = applySyncDistribution(damage, targetSlot, entries, data, logEntries)
    applyDamagesToPlayers(damages, entries, data, logEntries)
    if (clearSync) data.sync_active = false
  } else {
    // 플레이어 → 보스 공격
    const { hit, hitType } = calcHit(myPkmn, { accuracy: accuracy ?? 95 }, { type: data.boss_type ?? "노말" })
    if (!hit) { logEntries.push(makeLog("normal", "빗나갔다!")); return }
    const fakeBoss = makeFakeBoss(data)
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, fakeBoss)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${bossName}에게는 효과가 없다…`)); return }
    const finalDmg = Math.max(1, damage)
    data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - finalDmg)
    logEntries.push(makeLog("hit", "", { defender: "boss" }))
    logEntries.push(makeLog("hp",  "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
    if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
    if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
    if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
    if (data.boss_current_hp <= 0) logEntries.push(makeLog("faint", `${bossName}${josa(bossName, "은는")} 쓰러졌다!`, { slot: "boss" }))
  }
}

// ── 보스 객체 (타입 상성 계산용 가짜 객체) ──────────────────────────
function makeFakeBoss(data) {
  return {
    type:    data.boss_type    ?? "노말",
    defense: data.boss_defense ?? 5,
    speed:   data.boss_speed   ?? 3,
    ranks:   data.boss_rank    ?? defaultRanks(),
    hp:      data.boss_current_hp ?? 1,
    maxHp:   data.boss_max_hp  ?? 1,
    name:    data.boss_name    ?? "보스",
    status:  data.boss_status  ?? null,
  }
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
    logEntries.push(makeLog("hit", "", { defender: slot }))
    logEntries.push(makeLog("hp",  "", { slot, hp: pkmn.hp, maxHp: pkmn.maxHp }))
    if (pkmn.hp <= 0) logEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot }))
    // 참기 데미지 누적
    if (pkmn.bideState) {
      pkmn.bideState.damage = (pkmn.bideState.damage ?? 0) + dmg
      pkmn.bideState.lastAttackerSlot = "boss"
    }
  }
}

// ── finishTurn ────────────────────────────────────────────────────────
async function finishTurn(roomRef, roomId, data, entries, logEntries, extraUpdate = {}) {
  const { assistEventTs, syncEventTs } = await writeLogs(roomId, logEntries)

  const newOrder = (data.current_order ?? []).slice(1)
  const update   = {
    ...buildRaidEntryUpdate(entries),
    boss_current_hp: data.boss_current_hp ?? 0,
    boss_rank:       data.boss_rank       ?? defaultRanks(),
    boss_status:     data.boss_status     ?? null,
    boss_volatile:   data.boss_volatile   ?? {},
    sync_active:     data.sync_active     ?? false,
    current_order:   newOrder,
    turn_count:      (data.turn_count ?? 1) + 1,
    turn_started_at: newOrder.length > 0 ? Date.now() : null,
    ...(assistEventTs !== null ? { assist_event: { ts: assistEventTs } } : {}),
    ...(syncEventTs   !== null ? { sync_event:   { ts: syncEventTs   } } : {}),
    ...extraUpdate,
  }

  PLAYER_SLOTS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined) update[`${s}_active_idx`] = data[`${s}_active_idx`]
  })

  const result = checkRaidWin(entries, data.boss_current_hp ?? 0)
  if (result) {
    update.game_over     = true
    update.raid_result   = result
    update.current_order = []
    update.turn_started_at = null
  }

  await roomRef.update(update)
  return result
}

// ── EOT 처리 ─────────────────────────────────────────────────────────
async function handleRaidEot(roomRef, roomId, data, entries, update, logEntries) {
  const eotLogs = []

  PLAYER_SLOTS.forEach(s => {
    const idx  = data[`${s}_active_idx`] ?? 0
    const pkmn = entries[s]?.[idx]
    if (!pkmn || pkmn.hp <= 0) return

    // 랭크 틱
    tickRanks(pkmn, eotLogs)

    // 도발 틱
    if ((pkmn.taunted ?? 0) > 0) {
      pkmn.taunted--
      if (!pkmn.taunted) eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "의")} 도발이 풀렸다!`))
    }

    // 사슬묶기 틱
    if (pkmn.chainBound) {
      pkmn.chainBound.turnsLeft--
      if (pkmn.chainBound.turnsLeft <= 0) {
        pkmn.chainBound = null
        eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "의")} 사슬묶기가 풀렸다!`))
      }
    }

    // 회복봉인 틱
    if ((pkmn.healBlocked ?? 0) > 0) {
      pkmn.healBlocked--
      if (!pkmn.healBlocked) eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "의")} 회복봉인이 풀렸다!`))
    }

    // 지옥찌르기 틱
    if ((pkmn.throatChopped ?? 0) > 0) {
      pkmn.throatChopped--
      if (!pkmn.throatChopped) eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 다시 소리를 낼 수 있게 됐다!`))
    }

    // 아쿠아링
    if (pkmn.aquaRing) {
      const heal = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) * 0.0625))
      pkmn.hp = Math.min(pkmn.maxHp ?? pkmn.hp, pkmn.hp + heal)
      eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 아쿠아링으로 HP를 회복했다! (+${heal})`))
      eotLogs.push(makeLog("hp", "", { slot: s, hp: pkmn.hp, maxHp: pkmn.maxHp }))
    }

    // 저주
    if (pkmn.cursed && pkmn.hp > 0) {
      const dmg = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) * 0.25))
      pkmn.hp = Math.max(0, pkmn.hp - dmg)
      eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 저주 때문에 ${dmg} 데미지를 입었다!`))
      eotLogs.push(makeLog("hp", "", { slot: s, hp: pkmn.hp, maxHp: pkmn.maxHp }))
      if (pkmn.hp <= 0) eotLogs.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot: s }))
    }

    // 독/화상
    applyEndOfTurnDamage(pkmn).forEach(m => eotLogs.push(makeLog("normal", m)))
    if (pkmn.hp <= 0 && eotLogs.at(-1)?.type !== "faint")
      eotLogs.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot: s }))
  })

  // 씨뿌리기 EOT (플레이어 간)
  for (const tSlot of PLAYER_SLOTS) {
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot]?.[tIdx]
    if (!tPkmn || !tPkmn.seeded || tPkmn.hp <= 0) continue
    const seederSlot = tPkmn.seederSlot
    if (!seederSlot || !PLAYER_SLOTS.includes(seederSlot)) continue
    const sIdx  = data[`${seederSlot}_active_idx`] ?? 0
    const sPkmn = entries[seederSlot]?.[sIdx]
    const dmg   = Math.max(1, Math.floor((tPkmn.maxHp ?? tPkmn.hp) * 0.1))
    tPkmn.hp    = Math.max(0, tPkmn.hp - dmg)
    eotLogs.push(makeLog("normal", `씨뿌리기가 ${tPkmn.name}${josa(tPkmn.name, "의")} 체력을 빼앗는다!`))
    eotLogs.push(makeLog("hp", "", { slot: tSlot, hp: tPkmn.hp, maxHp: tPkmn.maxHp }))
    if (sPkmn && sPkmn.hp > 0) {
      sPkmn.hp = Math.min(sPkmn.maxHp ?? sPkmn.hp, sPkmn.hp + dmg)
      eotLogs.push(makeLog("hp", `${sPkmn.name}${josa(sPkmn.name, "은는")} 체력을 흡수했다! (+${dmg})`, { slot: seederSlot, hp: sPkmn.hp, maxHp: sPkmn.maxHp }))
    }
    if (tPkmn.hp <= 0) eotLogs.push(makeLog("faint", `${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`, { slot: tSlot }))
  }

  if (eotLogs.length > 0) {
    const logsRef = db.collection("raid").doc(roomId).collection("logs")
    const base    = Date.now()
    const batch   = db.batch()
    eotLogs.forEach((entry, i) => batch.set(logsRef.doc(), { ...entry, ts: base + i }))
    await batch.commit()
    Object.assign(update, buildRaidEntryUpdate(entries))
  }

  return checkRaidWin(entries, data.boss_current_hp ?? 0)
}

// ── 보스 턴 연속 처리 ────────────────────────────────────────────────
async function runBossIfNext(roomId, data, entries) {
  const snap     = await db.collection("raid").doc(roomId).get()
  const freshData = snap.data()
  if (!freshData || freshData.game_over) return null
  const order = freshData.current_order ?? []
  if (order[0] !== "boss") return null
  // entries는 최신 상태로 다시 읽어옴
  const freshEntries = deepCopyRaidEntries2(freshData)
  return executeBossAction(roomId, freshData, freshEntries, order)
}

// ════════════════════════════════════════════════════════════════════
//  메인 핸들러
// ════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST") return res.status(405).end()

  const { roomId, mySlot, moveIdx, targetSlots } = req.body
  if (!roomId || !mySlot || moveIdx === undefined)
    return res.status(400).json({ error: "파라미터 부족" })

  const roomRef = db.collection("raid").doc(roomId)
  const snap    = await roomRef.get()
  const data    = snap.data()
  if (!data) return res.status(404).json({ error: "방 없음" })
  if (!data.current_order || data.current_order[0] !== mySlot)
    return res.status(403).json({ error: "내 턴이 아님" })

  const bossName    = data.boss_name ?? "보스"
  const entries     = deepCopyRaidEntries(data)
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = entries[mySlot]?.[myActiveIdx]
  if (!myPkmn || myPkmn.hp <= 0) return res.status(403).json({ error: "포켓몬 기절 상태" })

  const moveData = myPkmn.moves?.[moveIdx]
  if (!moveData || moveData.pp <= 0) return res.status(403).json({ error: "사용 불가 기술" })

  // 봉인 체크
  if (myPkmn.chainBound?.moveName === moveData.name)
    return res.status(403).json({ error: "사슬묶기로 사용 불가" })
  if (myPkmn.tormented && moveData.name === myPkmn.lastUsedMove)
    return res.status(403).json({ error: "트집으로 사용 불가" })
  const soundMoves = ["금속음","돌림노래","바크아웃","소란피기","싫은소리","울부짖기","울음소리","차밍보이스","비밀이야기","하이퍼보이스","매혹의보이스"]
  if ((myPkmn.throatChopped ?? 0) > 0 && soundMoves.includes(moveData.name))
    return res.status(403).json({ error: "지옥찌르기로 사용 불가" })
  if ((myPkmn.taunted ?? 0) > 0 && !(moves[moveData.name]?.power > 0))
    return res.status(403).json({ error: "도발로 사용 불가" })

  // 어시스트 체크 (신청자면 데미지 +15%)
  const assistActive   = data.assist_active ?? false
  const assistFrom     = data.assist_request_from ?? null
  const isAssistCaster = assistActive && assistFrom === mySlot

  const logEntries = []

  // ── tickVolatiles ───────────────────────────────────────────────
  tickVolatiles(myPkmn).forEach(m => logEntries.push(makeLog("normal", m)))

  // ── 공중날기 2턴째 ──────────────────────────────────────────────
  if (myPkmn.flyState?.flying) {
    myPkmn.flyState = null
    const targetSlot = myPkmn._flyTargetSlot ?? "boss"
    myPkmn._flyTargetSlot = null
    logEntries.push(makeLog("move_announce", `${myPkmn.name}${josa(myPkmn.name, "은는")} 내려꽂는다!`))
    handleTwoTurnAttack(myPkmn, mySlot, targetSlot, entries, data, logEntries, { moveName: myPkmn.flyMoveName ?? "공중날기", accuracy: 95 })
    myPkmn.flyMoveName = null
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  // ── 구멍파기 2턴째 ──────────────────────────────────────────────
  if (myPkmn.digState?.digging) {
    myPkmn.digState = null
    const targetSlot = myPkmn._digTargetSlot ?? "boss"
    myPkmn._digTargetSlot = null
    logEntries.push(makeLog("move_announce", `${myPkmn.name}${josa(myPkmn.name, "은는")} 땅속에서 튀어나왔다!`))
    handleTwoTurnAttack(myPkmn, mySlot, targetSlot, entries, data, logEntries, { moveName: myPkmn.digMoveName ?? "구멍파기", accuracy: 100 })
    myPkmn.digMoveName = null
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  // ── 고스트다이브 2턴째 ──────────────────────────────────────────
  if (myPkmn.ghostDiveState?.diving) {
    myPkmn.ghostDiveState = null
    const targetSlot = myPkmn._ghostDiveTargetSlot ?? "boss"
    myPkmn._ghostDiveTargetSlot = null
    logEntries.push(makeLog("move_announce", `${myPkmn.name}${josa(myPkmn.name, "은는")} 나타났다!`))
    handleTwoTurnAttack(myPkmn, mySlot, targetSlot, entries, data, logEntries, { moveName: myPkmn.ghostDiveMoveName ?? "고스트다이브", accuracy: 100 })
    myPkmn.ghostDiveMoveName = null
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries, { [`force_switch_${mySlot}`]: false })
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  // ── 하이퍼빔 재충전 ─────────────────────────────────────────────
  if (myPkmn.hyperBeamState) {
    myPkmn.hyperBeamState = false
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 움직일 수 없다!`))
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  // ── 참기 자동처리 ───────────────────────────────────────────────
  if (myPkmn.bideState) {
    myPkmn.bideState.turnsLeft--
    if (myPkmn.bideState.turnsLeft > 0) {
      logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 참고 있다...`))
    } else {
      const bide = myPkmn.bideState
      myPkmn.bideState = null
      const bideDmg = (bide.damage ?? 0) * 2
      logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 참았던 에너지를 방출했다!`))
      if (bideDmg <= 0) {
        logEntries.push(makeLog("normal", "그러나 데미지가 없어서 실패했다!"))
      } else {
        data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - bideDmg)
        logEntries.push(makeLog("hit", "", { defender: "boss" }))
        logEntries.push(makeLog("hp",  "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
        logEntries.push(makeLog("after_hit", `${bideDmg} 데미지!`))
        if (data.boss_current_hp <= 0) logEntries.push(makeLog("faint", `${bossName}${josa(bossName, "은는")} 쓰러졌다!`, { slot: "boss" }))
      }
    }
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  // ── 구르기 자동처리 ─────────────────────────────────────────────
  if (myPkmn.rollState?.active) {
    const rollTurn  = myPkmn.rollState.turn + 1
    const rollPower = rollTurn === 1 ? 30 : rollTurn === 2 ? 60 : 120
    logEntries.push(makeLog("move_announce", `${myPkmn.name}의 구르기! (${rollTurn}번째)`))
    const fakeBoss = makeFakeBoss(data)
    const defTypes = Array.isArray(fakeBoss.type) ? fakeBoss.type : [fakeBoss.type]
    let mult = 1; for (const dt of defTypes) mult *= getTypeMultiplier("바위", dt)
    if (mult === 0) {
      logEntries.push(makeLog("normal", `${bossName}에게는 효과가 없다…`))
      myPkmn.rollState = { active: false, turn: 0 }
    } else {
      const dmg = Math.floor(rollPower * mult)
      data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - dmg)
      logEntries.push(makeLog("hit", "", { defender: "boss" }))
      logEntries.push(makeLog("hp",  "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
      logEntries.push(makeLog("after_hit", `구르기 ${rollTurn}번째 (${dmg} 데미지)!`))
      if (data.boss_current_hp <= 0) logEntries.push(makeLog("faint", `${bossName}${josa(bossName, "은는")} 쓰러졌다!`, { slot: "boss" }))
      myPkmn.rollState = rollTurn >= 3 || data.boss_current_hp <= 0
        ? { active: false, turn: 0 }
        : { active: true, turn: rollTurn, targetSlot: "boss" }
    }
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  // ── 역린(outrageState) 자동처리 ────────────────────────────────
  if (myPkmn.outrageState?.active) {
    const state      = myPkmn.outrageState
    const moveInfo   = moves[state.moveName] ?? {}
    const outInfo    = moveInfo.outrage ?? {}
    const power      = outInfo.powers?.[Math.min(state.turn - 1, (outInfo.powers?.length ?? 1) - 1)] ?? 80
    const isLastTurn = state.turn >= state.maxTurn
    const fakeBoss   = makeFakeBoss(data)
    const { damage, multiplier, critical } = calcDamage(myPkmn, state.moveName, fakeBoss, power)
    logEntries.push(makeLog("move_announce", `${myPkmn.name}의 ${state.moveName}!`))
    if (multiplier === 0) {
      logEntries.push(makeLog("normal", `${bossName}에게는 효과가 없다…`))
    } else {
      data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - damage)
      logEntries.push(makeLog("hit", "", { defender: "boss" }))
      logEntries.push(makeLog("hp",  "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
      if (critical) logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
      if (data.boss_current_hp <= 0) logEntries.push(makeLog("faint", `${bossName}${josa(bossName, "은는")} 쓰러졌다!`, { slot: "boss" }))
    }
    if (isLastTurn) {
      myPkmn.outrageState = null
      if (outInfo.confusion && (myPkmn.confusion ?? 0) <= 0) {
        myPkmn.confusion = Math.floor(Math.random() * 3) + 1
        logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 혼란에 빠졌다!`))
      }
    } else {
      myPkmn.outrageState = { ...state, turn: state.turn + 1 }
    }
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  // ── 일반 기술 처리 ──────────────────────────────────────────────
  const pre = checkPreActionStatus(myPkmn)
  pre.msgs.forEach(m => logEntries.push(makeLog("normal", m)))

  if (!pre.blocked) {
    const conf = checkConfusion(myPkmn)
    conf.msgs.forEach(m => logEntries.push(makeLog("normal", m)))

    if (!conf.selfHit) {
      // PP 소비
      myPkmn.moves[moveIdx] = { ...moveData, pp: moveData.pp - 1 }
      myPkmn.lastUsedMove   = moveData.name
      if (!myPkmn.usedMoves) myPkmn.usedMoves = []
      if (!myPkmn.usedMoves.includes(moveData.name)) myPkmn.usedMoves.push(moveData.name)

      const moveInfoRaw = moves[moveData.name]
      if (moveInfoRaw) moveInfoRaw._name = moveData.name
      const moveInfo = moveInfoRaw ?? null

      logEntries.push(makeLog("move_announce", `${myPkmn.name}의 ${moveData.name}!`))

      const tSlots    = targetSlots ?? []
      const fakeBoss  = makeFakeBoss(data)

      // 보스를 타겟으로 하는 기술인지 확인
      const hittingBoss = tSlots.includes("boss")

      // ── 비공격 기술 ──────────────────────────────────────────────
      if (!moveInfo?.power) {
        // 자기버프 / 상태기술 등은 기존 로직 그대로
        // 레이드에서는 타겟이 보스 or 자기자신만 존재
        if (moveInfo?.defend) {
          myPkmn.defending   = true
          myPkmn.defendTurns = 2
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 방어 태세에 들어갔다!`))
        } else if (moveInfo?.endure) {
          myPkmn.enduring = true
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 버티기 태세에 들어갔다!`))
        } else if (moveInfo?.amulet) {
          myPkmn.amuletTurns = 3
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 신비의 부적으로 몸을 감쌌다!`))
        } else if (moveInfo?.aquaRing) {
          myPkmn.aquaRing = true
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 물의 베일로 몸을 감쌌다!`))
        } else if (moveInfo?.bide) {
          myPkmn.bideState = { turnsLeft: 2, damage: 0 }
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 참기 시작했다!`))
        } else if (moveInfo?.charge) {
          myPkmn.charged = true
          applyRankChanges({ def: 1, turns: 2 }, myPkmn, myPkmn, moveData.name, logEntries)
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 전기를 충전했다!`))
        } else if (moveInfo?.wish) {
          myPkmn.wishTurns = 2
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 희망사항을 빌었다!`))
        } else if (moveInfo?.splash) {
          logEntries.push(makeLog("normal", "그러나 아무 일도 일어나지 않았다!"))
        } else if (moveInfo?.taunt) {
          // 레이드에서 도발은 보스 대상
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} ${bossName}${josa(bossName, "을를")} 도발했다!`))
          data.boss_volatile = { ...(data.boss_volatile ?? {}), taunted: 3 }
        } else if (moveInfo?.chainBind) {
          logEntries.push(makeLog("normal", `${bossName}의 마지막 기술을 봉인했다!`))
          const lastBossMove = data.boss_last_move ?? null
          if (lastBossMove) {
            data.boss_volatile = { ...(data.boss_volatile ?? {}), chainBound: { moveName: lastBossMove, turnsLeft: 2 } }
          }
        } else if (moveInfo?.healBlock) {
          logEntries.push(makeLog("normal", `${bossName}의 회복이 봉인됐다!`))
          data.boss_volatile = { ...(data.boss_volatile ?? {}), healBlocked: 3 }
        } else if (moveInfo?.torment) {
          logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "을를")} 트집 상태로 만들었다!`))
          data.boss_volatile = { ...(data.boss_volatile ?? {}), tormented: true }
        } else if (moveInfo?.leechSeed) {
          logEntries.push(makeLog("normal", `${bossName}에게 씨를 뿌렸다! (레이드에서는 효과 없음)`))
        } else if (moveInfo?.futureSight) {
          myPkmn.futureSight = { turnsLeft: 2, attackerName: myPkmn.name, power: 70, targetSlot: "boss" }
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 미래를 예지했다!`))
        } else if (moveInfo?.effect?.heal) {
          // 자기 회복
          if ((myPkmn.healBlocked ?? 0) <= 0) {
            const heal = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * moveInfo.effect.heal))
            myPkmn.hp  = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
            logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} HP를 회복했다! (+${heal})`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
          } else {
            logEntries.push(makeLog("normal", "회복이 봉인돼 있어서 실패했다!"))
          }
        } else if (moveInfo?.healPulse) {
          // 아군 회복 (pollenPuff 친화 처리 포함)
          const allyTarget = tSlots.find(s => PLAYER_SLOTS.includes(s) && s !== mySlot)
          if (allyTarget) {
            const aIdx  = data[`${allyTarget}_active_idx`] ?? 0
            const aPkmn = entries[allyTarget]?.[aIdx]
            if (aPkmn && aPkmn.hp > 0) {
              const heal = Math.max(1, Math.floor((aPkmn.maxHp ?? aPkmn.hp) * 0.22))
              aPkmn.hp   = Math.min(aPkmn.maxHp ?? aPkmn.hp, aPkmn.hp + heal)
              logEntries.push(makeLog("hp", `${aPkmn.name}${josa(aPkmn.name, "은는")} HP를 회복했다! (+${heal})`, { slot: allyTarget, hp: aPkmn.hp, maxHp: aPkmn.maxHp }))
            }
          }
        } else {
          // 일반 랭크 변화 등
          applyRankChanges(moveInfo?.rank ?? null, myPkmn, myPkmn, moveData.name, logEntries)
          applyMoveEffect(moveInfo?.effect, myPkmn, myPkmn, 0).forEach(m => logEntries.push(makeLog("normal", m)))
        }

      } else {
        // ── 공격 기술 ────────────────────────────────────────────
        if (moveInfo?.fly && !myPkmn.flyState?.flying) {
          myPkmn.flyState       = { flying: true }
          myPkmn.flyMoveName    = moveData.name
          myPkmn._flyTargetSlot = "boss"
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 하늘 높이 날아올랐다!`))
        } else if (moveInfo?.dig && !myPkmn.digState?.digging) {
          myPkmn.digState       = { digging: true }
          myPkmn.digMoveName    = moveData.name
          myPkmn._digTargetSlot = "boss"
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 땅속으로 파고들었다!`))
        } else if (moveInfo?.ghostDive && !myPkmn.ghostDiveState?.diving) {
          myPkmn.ghostDiveState       = { diving: true }
          myPkmn.ghostDiveMoveName    = moveData.name
          myPkmn._ghostDiveTargetSlot = "boss"
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 어둠 속으로 사라졌다!`))
        } else {
          // 일반 공격 → 보스
          const { hit, hitType } = calcHit(myPkmn, moveInfo, fakeBoss)
          if (!hit) {
            logEntries.push(makeLog("normal", hitType === "evaded" ? `${bossName}${josa(bossName, "이가")} 피했다!` : `${myPkmn.name}의 공격은 빗나갔다!`))
            if (moveInfo?.jumpKick) {
              const selfDmg = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.25))
              myPkmn.hp = Math.max(0, myPkmn.hp - selfDmg)
              logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 ${selfDmg} 데미지를 입었다!`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
              if (myPkmn.hp <= 0) logEntries.push(makeLog("faint", `${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`, { slot: mySlot }))
            }
          } else {
            // 데미지 계산
            let powerOverride = null
            if (moveInfo?.rollout) {
              const rollTurn = myPkmn.rollState?.active ? myPkmn.rollState.turn + 1 : 1
              powerOverride  = rollTurn === 1 ? 30 : rollTurn === 2 ? 60 : 120
              myPkmn.rollState = rollTurn >= 3
                ? { active: false, turn: 0 }
                : { active: true, turn: rollTurn, targetSlot: "boss" }
            }

            const { damage, multiplier, critical, dice, minRoll, minDice } = calcDamage(myPkmn, moveData.name, fakeBoss, powerOverride)
            logEntries.push(makeLog("dice", "", { slot: mySlot, roll: dice }))

            if (multiplier === 0) {
              logEntries.push(makeLog("normal", `${bossName}에게는 효과가 없다…`))
            } else {
              let finalDmg = damage

              // 어시스트 보정
              if (isAssistCaster) finalDmg = Math.floor(finalDmg * 1.15)

              // 전기 충전 보정
              const chargedMult = (myPkmn.charged && moveInfo?.type === "전기") ? 1.2 : 1.0
              myPkmn.charged = false
              if (chargedMult > 1) {
                finalDmg = Math.floor(finalDmg * chargedMult)
                logEntries.push(makeLog("after_hit", "충전된 전기로 위력이 올라갔다!"))
              }

              finalDmg = Math.max(1, finalDmg)
              data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - finalDmg)

              logEntries.push(makeLog("hit", "", { defender: "boss" }))
              logEntries.push(makeLog("hp",  "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
              if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
              if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
              if (minRoll)        logEntries.push(makeLog("after_hit", `${minDice}! (최소 피해 보장)`))
              else if (critical)  logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
              if (isAssistCaster) logEntries.push(makeLog("after_hit", "어시스트 효과로 위력이 올라갔다!"))

              if (data.boss_current_hp <= 0)
                logEntries.push(makeLog("faint", `${bossName}${josa(bossName, "은는")} 쓰러졌다!`, { slot: "boss" }))

              // 흡수
              if (moveInfo?.effect?.drain && finalDmg > 0) {
                const heal = Math.max(1, Math.floor(finalDmg * moveInfo.effect.drain))
                myPkmn.hp  = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
                logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 체력을 흡수했다! (+${heal})`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
              }
              // 반동
              if (moveInfo?.effect?.recoil && finalDmg > 0) {
                const recoil = Math.max(1, Math.floor(finalDmg * moveInfo.effect.recoil))
                myPkmn.hp = Math.max(0, myPkmn.hp - recoil)
                logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 ${recoil} 데미지를 입었다!`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
                if (myPkmn.hp <= 0) logEntries.push(makeLog("faint", `${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`, { slot: mySlot }))
              }
              // 보스 상태이상
              applyMoveEffect(moveInfo?.effect, myPkmn, fakeBoss, finalDmg).forEach(m => {
                if (m.includes("상태")) {
                  data.boss_status = moveInfo.effect?.status ?? null
                }
                logEntries.push(makeLog("normal", m))
              })
              // 하이퍼빔
              if (moveInfo?.hyperBeam) myPkmn.hyperBeamState = true
              // 유턴
              if (moveInfo?.uTurn) {
                const canSwitch = (entries[mySlot] ?? []).some((p, i) => i !== myActiveIdx && p.hp > 0)
                if (canSwitch) {
                  await writeLogs(roomId, logEntries)
                  await roomRef.update({
                    ...buildRaidEntryUpdate(entries),
                    boss_current_hp: data.boss_current_hp,
                    current_order:   [mySlot, ...(data.current_order ?? []).slice(1)],
                    turn_count:      data.turn_count ?? 1,
                    turn_started_at: data.turn_started_at,
                    [`force_switch_${mySlot}`]: true,
                  })
                  return res.status(200).json({ ok: true })
                }
              }
            }
          }
        }
      }
    }
  }

  // ── 어시스트 소비 ───────────────────────────────────────────────
  const assistUpdate = {}
  if (isAssistCaster) {
    assistUpdate.assist_active       = false
    assistUpdate.assist_request_from = null
    assistUpdate.assist_used         = true
  }

  // ── 싱크로 소비 (이 턴에 sync_active가 false로 바뀌었으면 used 처리) ─
  const syncUpdate = {}
  if (!data.sync_active && (data.sync_active !== (snap.data()?.sync_active))) {
    syncUpdate.sync_active = false
    syncUpdate.sync_used   = true
  }

  // ── EOT or 다음 턴 ──────────────────────────────────────────────
  const newOrder = (data.current_order ?? []).slice(1)
  const isEot    = newOrder.length === 0

  const update = {
    ...buildRaidEntryUpdate(entries),
    boss_current_hp: data.boss_current_hp ?? 0,
    boss_rank:       data.boss_rank       ?? defaultRanks(),
    boss_status:     data.boss_status     ?? null,
    boss_volatile:   data.boss_volatile   ?? {},
    boss_last_move:  data.boss_last_move  ?? null,
    sync_active:     data.sync_active     ?? false,
    current_order:   newOrder,
    turn_count:      (data.turn_count ?? 1) + 1,
    turn_started_at: newOrder.length > 0 ? Date.now() : null,
    ...assistUpdate,
    ...syncUpdate,
  }
  PLAYER_SLOTS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined) update[`${s}_active_idx`] = data[`${s}_active_idx`]
  })

  const { assistEventTs, syncEventTs } = await writeLogs(roomId, logEntries)
  if (assistEventTs !== null) update.assist_event = { ts: assistEventTs }
  if (syncEventTs   !== null) update.sync_event   = { ts: syncEventTs }

  const earlyResult = checkRaidWin(entries, data.boss_current_hp ?? 0)
  if (earlyResult) {
    update.game_over     = true
    update.raid_result   = earlyResult
    update.current_order = []
    update.turn_started_at = null
    await roomRef.update(update)
    return res.status(200).json({ ok: true, result: earlyResult })
  }

  if (isEot) {
    const eotResult = await handleRaidEot(roomRef, roomId, data, entries, update, logEntries)
    if (eotResult) {
      update.game_over     = true
      update.raid_result   = eotResult
      update.current_order = []
      update.turn_started_at = null
    }
  }

  await roomRef.update(update)

  // 다음 턴이 보스면 서버에서 연속 처리
  await runBossIfNext(roomId, data, entries).catch(e => console.warn("보스 연속 처리 오류:", e.message))

  return res.status(200).json({ ok: true })
}