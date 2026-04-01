// js/doublebattle.js
import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import {
  doc, collection, getDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"
import { moves } from "./moves.js"
import { josa } from "./effecthandler.js"

window.__moves = moves

const API = "https://pokedouble-eosin.vercel.app/api"

async function callApi(endpoint, data) {
  const res = await fetch(`${API}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  })
  const json = await res.json()
  if(!res.ok) throw new Error(json.error ?? "API 오류")
  return json
}

const _startRound    = (data) => callApi("startRound",    data)
const _useMove       = (data) => callApi("useMove",       data)
const _switchPkmn    = (data) => callApi("switchPokemon", data)
const _forcedSwitch  = (data) => callApi("forcedSwitch",  data)
const _skipTurn      = (data) => callApi("skipTurn",      data)
const _requestAssist = (data) => callApi("requestAssist", data)
const _acceptAssist  = (data) => callApi("acceptAssist",  data)
const _rejectAssist  = (data) => callApi("rejectAssist",  data)
const _requestSync   = (data) => callApi("requestSync",   data)
const _acceptSync    = (data) => callApi("acceptSync",    data)
const _rejectSync    = (data) => callApi("rejectSync",    data)
const _leaveGame     = (data) => callApi("leaveGame",     data)

const roomRef = doc(db, "double", ROOM_ID)
const logsRef = collection(db, "double", ROOM_ID, "logs")

// ── 상태 변수 ────────────────────────────────────
let mySlot = null, myUid = null
let myTurn = false, actionDone = false, gameOver = false
let renderedLogIds  = new Set()
let renderedSyncLogs = new Set()
let isSpectator = new URLSearchParams(location.search).get("spectator") === "true"

// ── 로그 큐 시스템 ───────────────────────────────
// 서버가 쓴 로그를 타입별로 순서대로 재생
let logQueue      = []   // { type, text, meta, ts }
let isProcessing  = false
let pendingRoomData = null  // 로그 재생 끝난 후 반영할 Firestore 데이터

// ── 타입 컬러 ────────────────────────────────────
const TYPE_COLORS = {
  "노말":"#949495","불":"#e56c3e","물":"#5185c5","전기":"#fbb917","풀":"#66a945",
  "얼음":"#6dc8eb","격투":"#e09c40","독":"#735198","땅":"#9c7743","바위":"#bfb889",
  "비행":"#a2c3e7","에스퍼":"#dd6b7b","벌레":"#9fa244","고스트":"#684870",
  "드래곤":"#535ca8","악":"#4c4948","강철":"#69a9c7","페어리":"#dab4d4"
}

// ── 유틸 ─────────────────────────────────────────
function $(id) { return document.getElementById(id) }
function rollD10() { return Math.floor(Math.random() * 10) + 1 }
function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

function teamOf(s)       { return ["p1","p2"].includes(s) ? "A" : "B" }
function allyOf(s)       { return s==="p1"?"p2":s==="p2"?"p1":s==="p3"?"p4":"p3" }
function enemySlotsOf(s) { return teamOf(s)==="A" ? ["p3","p4"] : ["p1","p2"] }

function isTeamAllDead(data) {
  if(!mySlot) return false
  const ally      = allyOf(mySlot)
  const myEntry   = data[`${mySlot}_entry`] ?? []
  const allyEntry = data[`${ally}_entry`]   ?? []
  return myEntry.every(p => p.hp <= 0) && allyEntry.every(p => p.hp <= 0)
}

function cannotRequestSupport(data) {
  if(!mySlot) return true
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = data[`${mySlot}_entry`]?.[myActiveIdx]
  const myFainted   = !myPkmn || myPkmn.hp <= 0
  const allyPending = (data.pending_switches ?? []).includes(allyOf(mySlot))
  return myFainted || allyPending
}

function slotToPrefix(slot) {
  if(!mySlot) return null
  if(slot === mySlot)          return "my"
  if(slot === allyOf(mySlot))  return "ally"
  const enemies = enemySlotsOf(mySlot)
  return slot === enemies[0] ? "enemy1" : "enemy2"
}

// ── HP 바 ─────────────────────────────────────────
function updateHpBar(barId, textId, hp, maxHp, showNum) {
  const bar = $(barId), txt = textId ? $(textId) : null
  if(!bar) return
  const pct = maxHp > 0 ? Math.max(0, Math.min(100, hp / maxHp * 100)) : 0
  bar.style.width = pct + "%"
  bar.style.backgroundColor = pct > 50 ? "#4caf50" : pct > 20 ? "#ff9800" : "#f44336"
  if(txt) txt.innerText = showNum ? `HP: ${hp} / ${maxHp}` : ""
}

// ── 포트레이트 ────────────────────────────────────
function updatePortrait(prefix, pokemon) {
  const img = $(`${prefix}-portrait`)
  const ph  = $(`${prefix}-portrait-placeholder`)
  if(!img) return
  if(!pokemon?.portrait) {
    img.classList.remove("visible"); img.style.display = "none"
    if(ph) ph.style.display = "block"
    return
  }
  if(ph) ph.style.display = "none"
  img.classList.remove("visible")
  img.style.display = "block"; img.src = pokemon.portrait; img.alt = pokemon.name
  setTimeout(() => img.classList.add("visible"), 60)
}

// ── 슬롯 UI 갱신 (HP 바는 로그 큐 통해서만) ──────
// isHpFromLog=true 면 HP 바도 같이 업데이트 (로그 큐에서 호출)
// isHpFromLog=false 면 이름/포트레이트만 업데이트
function updateSlotUI(slot, data, isHpFromLog = false) {
  const prefix = slotToPrefix(slot)
  if(!prefix) return
  const activeIdx = data[`${slot}_active_idx`] ?? 0
  const pokemon   = data[`${slot}_entry`]?.[activeIdx]
  if(!pokemon) return

  const slotKey   = slot.replace("p", "player")
  const nameLabel = $(`${prefix}-name-label`)
  if(nameLabel) nameLabel.innerText = data[`${slotKey}_name`] ?? slot

  const nameEl = $(`${prefix}-active-name`)
  if(nameEl) nameEl.innerText = pokemon.name ?? "???"

  const isMyTeam = prefix === "my" || prefix === "ally"
  if(isHpFromLog) {
    updateHpBar(`${prefix}-hp-bar`, `${prefix}-active-hp`, pokemon.hp, pokemon.maxHp, isMyTeam)
  }
  updatePortrait(prefix, pokemon)
}

// ── 로그 큐: 타입별 핸들러 ──────────────────────
async function handleLogEntry(entry) {
  const { type, text, meta } = entry
  const logEl = $("battle-log")

  switch(type) {

    // ① 일반 텍스트
    case "normal":
    case "after_hit": {
      if(!text) break
      await typeText(logEl, text)
      await wait(120)
      break
    }

    // ② 기술명 선언 — 텍스트만 (약간 굵게 표시 가능)
    case "move_announce": {
      if(!text) break
      await typeText(logEl, text)
      await wait(200)
      break
    }

    // ③ 주사위 애니메이션
    case "dice": {
      if(!meta) break
      await animateAttackDice(meta.slot, meta.roll)
      break
    }

    // ④ hit — 넉백 이펙트 + blink
    case "hit": {
      if(!meta?.defender) break
      const prefix = slotToPrefix(meta.defender)
      if(prefix) {
        await triggerAttackEffect(prefix)
        await triggerBlink(prefix)
      }
      break
    }

    // ⑤ HP 바 업데이트
    case "hp": {
      if(!meta?.slot) break
      const prefix = slotToPrefix(meta.slot)
      if(!prefix) break
      const isMyTeam = prefix === "my" || prefix === "ally"
      // 애니메이션: 부드럽게 줄어드는 효과
      await animateHpBar(prefix, meta.hp, meta.maxHp, isMyTeam)
      if(text) await typeText(logEl, text)
      await wait(100)
      break
    }

    // ⑥ ASSIST! 애니메이션
    case "assist": {
      await showAssistAnimation()
      break
    }

    // ⑦ SYNCHRONIZE! 애니메이션
    case "sync": {
      await showSyncAnimation()
      break
    }

    // ⑧ 기절 로그
    case "faint": {
      if(text) await typeText(logEl, text)
      // 기절 포켓몬 이미지 흐리게
      if(meta?.slot) {
        const prefix = slotToPrefix(meta.slot)
        const area   = $(`${prefix}-pokemon-area`)
        if(area) area.classList.add("fainted")
      }
      await wait(300)
      break
    }

    default: {
      if(text) await typeText(logEl, text)
      break
    }
  }
}

// ── 타이핑 텍스트 ────────────────────────────────
function typeText(logEl, text) {
  return new Promise(resolve => {
    if(!logEl) { resolve(); return }
    const line   = document.createElement("p")
    logEl.appendChild(line)
    const chars  = [...text]; let i = 0
    function next() {
      if(i >= chars.length) { logEl.scrollTop = logEl.scrollHeight; resolve(); return }
      line.textContent += chars[i++]
      logEl.scrollTop = logEl.scrollHeight
      setTimeout(next, 18)
    }
    next()
  })
}

// ── 로그 큐 처리 ─────────────────────────────────
function enqueueLogs(entries) {
  entries.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
  // type 없는 옛날 로그도 normal로 처리 (startRound 등 하위 호환)
  entries.forEach(e => { if(!e.type) e.type = "normal" })
  logQueue.push(...entries)
  processLogQueue()
}

async function processLogQueue() {
  if(isProcessing) return
  if(logQueue.length === 0) {
    // 큐가 완전히 빌 때 pendingRoomData 반영
    if(pendingRoomData) {
      const data = pendingRoomData
      pendingRoomData = null
      // 약간 딜레이 줘서 마지막 애니메이션이 끝난 후 반영
      setTimeout(() => applyRoomData(data), 80)
    }
    return
  }
  isProcessing = true
  const entry = logQueue.shift()
  try {
    await handleLogEntry(entry)
  } catch(e) {
    console.warn("logEntry 처리 오류:", e)
  }
  isProcessing = false
  // 엔트리 사이 간격 (너무 짧으면 버튼 상태 갱신 타이밍 꼬임)
  setTimeout(processLogQueue, 50)
}

// ── HP 바 애니메이션 (부드럽게) ──────────────────
function animateHpBar(prefix, targetHp, maxHp, showNum) {
  return new Promise(resolve => {
    const bar = $(`${prefix}-hp-bar`)
    const txt = $(`${prefix}-active-hp`)
    if(!bar) { resolve(); return }

    const targetPct = maxHp > 0 ? Math.max(0, Math.min(100, targetHp / maxHp * 100)) : 0
    const color = targetPct > 50 ? "#4caf50" : targetPct > 20 ? "#ff9800" : "#f44336"

    bar.style.transition = "width 0.4s ease, background-color 0.4s ease"
    bar.style.width      = targetPct + "%"
    bar.style.backgroundColor = color
    if(txt && showNum) txt.innerText = `HP: ${targetHp} / ${maxHp}`

    setTimeout(() => {
      bar.style.transition = ""
      resolve()
    }, 420)
  })
}

// ── 히트 이펙트 ─────────────────────────────────
function triggerAttackEffect(defPrefix) {
  return new Promise(resolve => {
    const defArea = $(`${defPrefix}-pokemon-area`)
    const wrapper = $("battle-wrapper")
    if(wrapper) {
      wrapper.classList.remove("screen-shake"); void wrapper.offsetWidth
      wrapper.classList.add("screen-shake")
      wrapper.addEventListener("animationend", () => wrapper.classList.remove("screen-shake"), { once: true })
    }
    if(defArea) {
      defArea.classList.remove("defender-hit"); void defArea.offsetWidth
      defArea.classList.add("defender-hit")
      defArea.addEventListener("animationend", () => { defArea.classList.remove("defender-hit"); resolve() }, { once: true })
    } else resolve()
  })
}

function triggerBlink(prefix) {
  return new Promise(resolve => {
    const area = $(`${prefix}-pokemon-area`)
    if(!area) { resolve(); return }
    area.classList.remove("blink-damage"); void area.offsetWidth
    area.classList.add("blink-damage")
    area.addEventListener("animationend", () => { area.classList.remove("blink-damage"); resolve() }, { once: true })
  })
}

// ── 주사위 애니메이션 ────────────────────────────
function animateAttackDice(slot, finalRoll) {
  return new Promise(resolve => {
    const wrap   = $("dice-wrap")
    const diceEl = $(`dice-${slot}`)
    if(!wrap || !diceEl) { resolve(); return }

    ;["p1","p2","p3","p4"].forEach(s => {
      const box = $(`dice-box-${s}`)
      if(box) box.style.display = s === slot ? "block" : "none"
    })

    wrap.style.display = "flex"
    let count = 0
    const iv = setInterval(() => {
      diceEl.innerText = rollD10()
      if(++count >= 16) {
        clearInterval(iv)
        diceEl.innerText = finalRoll
        diceEl.classList.remove("pop"); void diceEl.offsetWidth; diceEl.classList.add("pop")
        setTimeout(() => { wrap.style.display = "none"; resolve() }, 900)
      }
    }, 55)
  })
}

// 라운드 시작 주사위 (4명 동시)
function animateRoundDice(rolls, slots) {
  return new Promise(resolve => {
    const wrap = $("dice-wrap")
    if(!wrap) { resolve(); return }

    ;["p1","p2","p3","p4"].forEach(s => {
      const box = $(`dice-box-${s}`)
      if(box) box.style.display = slots.includes(s) ? "block" : "none"
    })

    wrap.style.display = "flex"
    let count = 0
    const iv = setInterval(() => {
      slots.forEach(s => {
        const el = $(`dice-${s}`)
        if(el) el.innerText = rollD10()
      })
      if(++count >= 20) {
        clearInterval(iv)
        slots.forEach(s => {
          const el = $(`dice-${s}`)
          if(el) {
            el.innerText = rolls[s]
            el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop")
          }
        })
        setTimeout(() => { wrap.style.display = "none"; resolve() }, 1600)
      }
    }, 60)
  })
}

// ── ASSIST! 애니메이션 ───────────────────────────
function showAssistAnimation() {
  return new Promise(resolve => {
    const el = $("assist-anim")
    if(!el) { resolve(); return }
    el.classList.remove("assist-show")
    void el.offsetWidth
    el.classList.add("assist-show")
    setTimeout(resolve, 800)
  })
}

// ── SYNCHRONIZE! 애니메이션 ──────────────────────
function showSyncAnimation() {
  return new Promise(resolve => {
    const el = $("sync-anim")
    if(!el) { resolve(); return }
    el.classList.remove("sync-show")
    void el.offsetWidth
    el.classList.add("sync-show")
    setTimeout(resolve, 800)
  })
}

// ── 기술 버튼 ────────────────────────────────────
function updateMoveButtons(data) {
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPokemon   = data[`${mySlot}_entry`]?.[myActiveIdx]
  const fainted     = !myPokemon || myPokemon.hp <= 0
  const movesArr    = myPokemon?.moves ?? []

  for(let i = 0; i < 4; i++) {
    const btn = $(`move-btn-${i}`)
    if(!btn) continue
    if(i >= movesArr.length) {
      btn.innerHTML = '<span style="font-size:13px">-</span>'
      btn.disabled = true; btn.onclick = null; continue
    }
    const mv       = movesArr[i]
    const moveInfo = moves[mv.name] ?? {}
    const acc      = moveInfo.alwaysHit ? "필중" : `${moveInfo.accuracy ?? 100}%`

    btn.innerHTML = `
      <span style="display:block;font-size:13px;font-weight:bold">${mv.name}</span>
      <span style="display:block;font-size:10px;opacity:.85">PP: ${mv.pp} | ${acc}</span>
    `
    const color = TYPE_COLORS[moveInfo.type] ?? "#a0a0a0"
    btn.style.setProperty("--btn-color", color)
    btn.style.background = color
    btn.style.boxShadow  = `inset 0 0 0 2px white, 0 0 0 2px ${color}`

    const canUse = !isSpectator && !fainted && mv.pp > 0 && myTurn && !actionDone
    btn.disabled = !canUse
    btn.onclick  = canUse ? () => onMoveClick(i, moveInfo, data) : null
  }
}

// ── 기술 클릭 ────────────────────────────────────
let pendingMoveIdx = -1

function onMoveClick(idx, moveInfo, data) {
  if(actionDone) return

  const r = moveInfo?.rank
  const targetsEnemy =
    moveInfo?.power
    || (r && (r.targetAtk !== undefined || r.targetDef !== undefined || r.targetSpd !== undefined))
    || moveInfo?.roar || moveInfo?.leechSeed || moveInfo?.chainBind
    || moveInfo?.dragonTail || moveInfo?.healPulse
    || (moveInfo?.effect?.volatile && !moveInfo?.targetSelf)

  const targetsAlly = moveInfo?.healPulse

  if(targetsEnemy || targetsAlly) {
    enterTargetMode(idx, data, { targetsEnemy: !!targetsEnemy, targetsAlly: !!targetsAlly })
  } else {
    doUseMove(idx, [], data)
  }
}

function enterTargetMode(idx, data, { targetsEnemy = true, targetsAlly = false } = {}) {
  pendingMoveIdx = idx
  const hint = $("target-hint")
  if(hint) hint.style.display = "block"

  const clickableSlots = []
  if(targetsEnemy) enemySlotsOf(mySlot).forEach(s => clickableSlots.push(s))
  if(targetsAlly)  clickableSlots.push(allyOf(mySlot))

  clickableSlots.forEach(eSlot => {
    const eActiveIdx = data[`${eSlot}_active_idx`] ?? 0
    const ePkmn      = data[`${eSlot}_entry`]?.[eActiveIdx]
    if(!ePkmn || ePkmn.hp <= 0) return
    const prefix = slotToPrefix(eSlot)
    const area   = $(`${prefix}-pokemon-area`)
    if(!area) return
    area.classList.add("target-selectable")
    area.onclick = () => {
      const capturedIdx = pendingMoveIdx
      exitTargetMode()
      doUseMove(capturedIdx, [eSlot], data)
    }
  })
}

function exitTargetMode() {
  pendingMoveIdx = -1
  const hint = $("target-hint")
  if(hint) hint.style.display = "none"
  ;["enemy1","enemy2","ally"].forEach(prefix => {
    const area = $(`${prefix}-pokemon-area`)
    if(!area) return
    area.classList.remove("target-selectable")
    area.onclick = null
  })
}

async function doUseMove(moveIdx, targetSlots, data) {
  if(actionDone) return
  actionDone = true
  updateMoveButtons(data)
  try {
    await _useMove({ roomId: ROOM_ID, mySlot, moveIdx, targetSlots })
  } catch(e) {
    console.error("useMove 오류:", e.message)
    actionDone = false
    updateMoveButtons(data)
  }
}

// ── 교체 버튼 ────────────────────────────────────
function updateBenchButtons(data) {
  const bench = $("bench-container")
  if(!bench) return
  bench.innerHTML = ""

  const myEntry   = data[`${mySlot}_entry`] ?? []
  const activeIdx = data[`${mySlot}_active_idx`] ?? 0
  const pending   = data.pending_switches ?? []
  const isForcedSwitch = pending.includes(mySlot)

  const forcedHint = $("forced-switch-hint")
  if(forcedHint) forcedHint.style.display = isForcedSwitch && !isSpectator ? "block" : "none"

  myEntry.forEach((pkmn, idx) => {
    if(idx === activeIdx) return
    const btn = document.createElement("button")
    if(pkmn.hp <= 0) {
      btn.innerHTML = `<span class="bench-name">${pkmn.name}</span><span class="bench-hp">기절</span>`
      btn.disabled  = true
    } else {
      btn.innerHTML = `<span class="bench-name">${pkmn.name}</span><span class="bench-hp">HP: ${pkmn.hp}/${pkmn.maxHp}</span>`
      if(isSpectator) {
        btn.disabled = true
      } else if(isForcedSwitch) {
        btn.disabled = false
        btn.classList.add("forced-switch")
        btn.onclick  = () => doForcedSwitch(idx)
      } else {
        btn.disabled = !myTurn || actionDone
        if(!btn.disabled) btn.onclick = () => doSwitchPokemon(idx, data)
      }
    }
    bench.appendChild(btn)
  })
}

async function doSwitchPokemon(newIdx, data) {
  if(actionDone) return
  actionDone = true
  const bench = $("bench-container")
  if(bench) bench.querySelectorAll("button").forEach(b => { b.disabled = true; b.onclick = null })
  try {
    await _switchPkmn({ roomId: ROOM_ID, mySlot, newIdx })
  } catch(e) {
    console.error("switchPokemon 오류:", e.message)
    actionDone = false
    updateBenchButtons(data)
  }
}

async function doForcedSwitch(newIdx) {
  try {
    await _forcedSwitch({ roomId: ROOM_ID, mySlot, newIdx })
  } catch(e) {
    console.error("forcedSwitch 오류:", e.message)
  }
}

// ── 행동 순서 표시 ───────────────────────────────
function updateOrderDisplay(data) {
  const el = $("order-display")
  if(!el) return
  const order = data.current_order ?? []
  if(order.length === 0) { el.innerHTML = ""; return }
  el.innerHTML = order.map((slot, i) => {
    const slotKey = slot.replace("p", "player")
    const name    = (data[`${slotKey}_name`] ?? slot).split("]").pop().trim()
    const isActive = i === 0
    const isMine   = slot === mySlot
    let cls = "order-item"
    if(isActive) cls += " active"
    else if(isMine) cls += " mine"
    return `<div class="${cls}">${i+1}. ${name}</div>`
  }).join("")
}

// ── 턴 표시 ──────────────────────────────────────
function updateTurnUI(data) {
  const el = $("turn-display")
  if(!el) return
  const order   = data.current_order ?? []
  const pending = data.pending_switches ?? []

  if(isSpectator) {
    if(order.length > 0) {
      const s       = order[0]
      const slotKey = s.replace("p", "player")
      const name    = (data[`${slotKey}_name`] ?? s).split("]").pop().trim()
      el.innerText  = `${name}의 턴`; el.style.color = "#333"
    } else {
      el.innerText = "라운드 대기 중..."; el.style.color = "#aaa"
    }
    return
  }

  if(pending.includes(mySlot)) {
    el.innerText = "교체할 포켓몬을 선택!"; el.style.color = "#e67e22"
  } else if(order.length === 0) {
    el.innerText = "라운드 대기 중..."; el.style.color = "#aaa"
  } else if(order[0] === mySlot) {
    el.innerText = "내 턴!"; el.style.color = "green"
  } else {
    const idx    = order.indexOf(mySlot)
    el.innerText = idx > 0 ? `${idx}번째 대기중...` : "상대 턴..."
    el.style.color = "gray"
  }

  const tc = $("turn-count")
  if(tc) tc.innerText = `${data.round_count ?? 0}라운드 / ${data.turn_count ?? 0}턴`
}

// ── 어시스트 UI ──────────────────────────────────
function updateAssistUI(data) {
  const myTeam   = teamOf(mySlot)
  const assist   = data[`assist_team${myTeam}`] ?? null
  const used     = data[`assist_used_${myTeam}`] ?? false
  const req      = data.assist_request ?? null
  const teamDead = isTeamAllDead(data)
  const blocked  = cannotRequestSupport(data)

  const reqBtn = $("assist-request-btn")
  if(reqBtn) {
    const isMyReq = req && req.from === mySlot
    if(isSpectator || used || assist || teamDead || blocked) {
      reqBtn.disabled  = true
      reqBtn.innerText = teamDead ? "사용 불가" : assist ? "🤝 어시스트 중" : used ? "지원 완료" : blocked ? "요청 불가" : "지원 요청"
    } else if(isMyReq) {
      reqBtn.disabled = true; reqBtn.innerText = "요청 중..."
    } else {
      reqBtn.disabled = false; reqBtn.innerText = "지원 요청"
    }
  }

  const statusEl = $("assist-status")
  if(statusEl) {
    if(assist?.requester === mySlot) {
      statusEl.innerText = `🤝 어시스트 대기 중 (${assist.supporterName})`; statusEl.style.color = "#e67e22"
    } else if(assist?.supporter === mySlot) {
      statusEl.innerText = `🤝 어시스트 지원 중 (${assist.requesterName})`; statusEl.style.color = "#3498db"
    } else {
      statusEl.innerText = ""
    }
  }

  const popup = $("assist-popup")
  if(popup) {
    if(req && req.to === mySlot && !isSpectator) {
      popup.style.display = "block"
      const nameEl = $("assist-popup-name")
      if(nameEl) nameEl.innerText = req.fromName ?? req.from
    } else {
      popup.style.display = "none"
    }
  }
}

// ── 싱크로나이즈 UI ──────────────────────────────
function updateSyncUI(data) {
  const myTeam   = teamOf(mySlot)
  const sync     = data[`sync_team${myTeam}`] ?? null
  const used     = data[`sync_used_${myTeam}`] ?? false
  const req      = data.sync_request ?? null
  const teamDead = isTeamAllDead(data)
  const blocked  = cannotRequestSupport(data)

  const reqBtn = $("sync-request-btn")
  if(reqBtn) {
    const isMyReq = req && req.from === mySlot
    if(isSpectator || used || sync || teamDead || blocked) {
      reqBtn.disabled  = true
      reqBtn.innerText = teamDead ? "사용 불가" : sync ? "💠 싱크로나이즈 중" : used ? "동기화 완료" : blocked ? "요청 불가" : "동기화 요청"
    } else if(isMyReq) {
      reqBtn.disabled = true; reqBtn.innerText = "요청 중..."
    } else {
      reqBtn.disabled = false; reqBtn.innerText = "동기화 요청"
    }
  }

  const statusEl = $("sync-status")
  if(statusEl) {
    if(sync?.requester === mySlot || sync?.supporter === mySlot) {
      const partner = sync.requester === mySlot ? sync.supporterName : sync.requesterName
      statusEl.innerText = `💠 싱크로나이즈 (${partner})`; statusEl.style.color = "#9b59b6"
    } else {
      statusEl.innerText = ""
    }
  }

  const popup = $("sync-popup")
  if(popup) {
    if(req && req.to === mySlot && !isSpectator) {
      popup.style.display = "block"
      const nameEl = $("sync-popup-name")
      if(nameEl) nameEl.innerText = req.fromName ?? req.from
    } else {
      popup.style.display = "none"
    }
  }

  // sync_log 처리도 logQueue로
  const myTeamKey = `sync_log_${myTeam}`
  const syncLog   = data[myTeamKey]
  if(syncLog && !renderedSyncLogs.has(syncLog)) {
    renderedSyncLogs.add(syncLog)
    logQueue.push({ type: "normal", text: syncLog, ts: Date.now() })
    processLogQueue()
  }
}

// ── 게임 종료 ────────────────────────────────────
function showGameOver(data) {
  if(gameOver) return
  gameOver = true
  exitTargetMode()

  const myTeam = teamOf(mySlot)
  const win    = data.winner_team === myTeam
  const td     = $("turn-display")

  if(isSpectator) {
    if(td) { td.innerText = `🏆 팀 ${data.winner_team} 승리!`; td.style.color = "gold" }
  } else {
    if(td) { td.innerText = win ? "🏆 승리!" : "💀 패배..."; td.style.color = win ? "gold" : "red" }
  }

  for(let i = 0; i < 4; i++) { const b = $(`move-btn-${i}`); if(b) { b.disabled = true; b.onclick = null } }
  const bench = $("bench-container"); if(bench) bench.innerHTML = ""

  const lb = $("leaveBtn")
  if(lb) { lb.style.display = "inline-block"; lb.disabled = false; lb.onclick = leaveGame }
}

// ── 턴 스킵 ─────────────────────────────────────
async function doSkipTurn() {
  try {
    await _skipTurn({ roomId: ROOM_ID, mySlot })
  } catch(e) {
    console.warn("skipTurn 오류:", e.message)
    actionDone = false
  }
}

// ── Firestore 데이터를 UI에 실제 반영 ────────────
// 로그 큐가 비었을 때 호출 (HP는 이미 로그 큐 통해 반영됨)
function applyRoomData(data) {
  ;["p1","p2","p3","p4"].forEach(s => updateSlotUI(s, data, false))
  updateOrderDisplay(data)
  updateTurnUI(data)
  if(!isSpectator) {
    updateMoveButtons(data)
    updateBenchButtons(data)
    updateAssistUI(data)
    updateSyncUI(data)
  }

  const spectEl = $("spectator-list")
  if(spectEl) {
    const names = data.spectator_names ?? []
    spectEl.innerText = names.length > 0 ? "관전: " + names.join(", ") : ""
  }

  if(data.game_over) {
    showGameOver(data)
    return
  }
}

// ── listenLogs: 새 로그 감지 → 큐에 추가 ────────
function listenLogs(gameStartedAt) {
  const q = query(logsRef, orderBy("ts"))
  onSnapshot(q, snap => {
    const newEntries = []
    snap.docs.forEach(d => {
      if(renderedLogIds.has(d.id)) return
      const logData = d.data()
      if(gameStartedAt && logData.ts < gameStartedAt) return
      renderedLogIds.add(d.id)
      newEntries.push(logData)
    })
    if(newEntries.length > 0) enqueueLogs(newEntries)
  })
}

// ── listenRoom: Firestore 변경 감지 ─────────────
// 턴 상태(myTurn/actionDone)는 즉시 세팅 -> 버튼이 로그 재생 중에도 풀림
// HP/포트레이트 등 무거운 UI는 큐 끝난 후 applyRoomData에서 처리
let lastDiceEventTs = 0

function listenRoom() {
  onSnapshot(roomRef, async snap => {
    const data = snap.data()
    if(!data || !data.p1_entry) return

    // 라운드 시작 주사위
    if(data.dice_event && data.dice_event.ts > lastDiceEventTs) {
      lastDiceEventTs = data.dice_event.ts
      await animateRoundDice(data.dice_event.rolls, data.dice_event.slots)
    }

    // 턴 상태 즉시 세팅 (UI 렌더링과 분리)
    if(!isSpectator && !data.game_over) {
      const order   = data.current_order ?? []
      const pending = data.pending_switches ?? []
      const wasMyTurn   = myTurn
      const isMyTurnNow = order[0] === mySlot
      myTurn = isMyTurnNow
      if(!wasMyTurn && isMyTurnNow) actionDone = false
      if(pending.includes(mySlot))  actionDone = false
      // 내 턴인데 포켓몬 전멸 -> skipTurn
      if(myTurn && !actionDone) {
        const myEntry = data[`${mySlot}_entry`] ?? []
        if(myEntry.every(p => p.hp <= 0)) {
          actionDone = true; doSkipTurn()
        }
      }
      // 라운드 시작 트리거
      if(order.length === 0 && pending.length === 0 && data.game_started) {
        tryStartRound()
      }
    }

    // UI 렌더링: 로그 큐 비어있으면 바로, 재생 중이면 pending
    if(!isProcessing && logQueue.length === 0) {
      applyRoomData(data)
    } else {
      pendingRoomData = data
    }
  })
}

// ── startRound (중복 방지) ───────────────────────
let startRoundLock = false
async function tryStartRound() {
  if(startRoundLock) return
  startRoundLock = true
  try {
    await _startRound({ roomId: ROOM_ID, mySlot })
  } catch(e) {
    console.warn("startRound:", e.message)
  } finally {
    setTimeout(() => startRoundLock = false, 3000)
  }
}

// ── 어시스트 액션 ────────────────────────────────
async function doRequestAssist() {
  if(!myTurn) { alert("자신의 턴에만 지원 요청할 수 있어!"); return }
  try { await _requestAssist({ roomId: ROOM_ID, mySlot }) }
  catch(e) { alert(`어시스트 요청 실패: ${e.message}`) }
}
async function doAcceptAssist() {
  try { await _acceptAssist({ roomId: ROOM_ID, mySlot }) }
  catch(e) { alert(`수락 실패: ${e.message}`) }
}
async function doRejectAssist() {
  try { await _rejectAssist({ roomId: ROOM_ID }) }
  catch(e) { console.warn("거절 실패:", e.message) }
}

// ── 싱크 액션 ────────────────────────────────────
async function doRequestSync() {
  if(!myTurn) { alert("자신의 턴에만 동기화 요청할 수 있어!"); return }
  try { await _requestSync({ roomId: ROOM_ID, mySlot }) }
  catch(e) { alert(`동기화 요청 실패: ${e.message}`) }
}
async function doAcceptSync() {
  try { await _acceptSync({ roomId: ROOM_ID, mySlot }) }
  catch(e) { alert(`수락 실패: ${e.message}`) }
}
async function doRejectSync() {
  try { await _rejectSync({ roomId: ROOM_ID }) }
  catch(e) { console.warn("거절 실패:", e.message) }
}

// ── 방 나가기 ────────────────────────────────────
async function leaveGame() {
  try { await _leaveGame({ roomId: ROOM_ID, myUid }) }
  catch(e) { console.error("leaveGame 오류:", e) }
  location.href = "../main.html"
}

// ── 인증 후 시작 ─────────────────────────────────
onAuthStateChanged(auth, async user => {
  if(!user) return
  myUid = user.uid

  const roomSnap = await getDoc(roomRef)
  const data     = roomSnap.data()
  ;["p1","p2","p3","p4"].forEach(s => {
    const slotKey = s.replace("p", "player")
    if(data?.[`${slotKey}_uid`] === myUid) mySlot = s
  })

  if(isSpectator) {
    const td = $("turn-display")
    if(td) { td.innerText = "관전 중"; td.style.color = "gray" }
  }

  if(window.initDoubleChat) {
    const userSnap = await getDoc(doc(db, "users", myUid))
    window.__myDisplayName = userSnap.data()?.nickname ?? myUid.slice(0, 6)
    window.initDoubleChat({ db, ROOM_ID, myUid, mySlot, isSpectator })
  }

  listenLogs(data?.game_started_at ?? 0)
  listenRoom()
})

// HTML onclick에서 접근
window.__doRequestAssist = doRequestAssist
window.__doAcceptAssist  = doAcceptAssist
window.__doRejectAssist  = doRejectAssist
window.__doRequestSync   = doRequestSync
window.__doAcceptSync    = doAcceptSync
window.__doRejectSync    = doRejectSync