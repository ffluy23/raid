// js/raidroom.js
import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import {
  doc, getDoc, updateDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"

const roomRef = doc(db, "raid", ROOM_ID)
let myUid         = null
let myDisplayName = null
let navigated     = false
let isAdmin       = false

const PLAYER_SLOTS = ["player1", "player2", "player3"]
const SLOT_TO_FS   = { player1: "p1", player2: "p2", player3: "p3" }

function calcMySlot(room) {
  if (!room || !myUid) return null
  for (const slot of PLAYER_SLOTS) {
    if (room[`${slot}_uid`] === myUid) return slot
  }
  if ((room.spectators ?? []).includes(myUid)) return "spectator"
  return null
}

onAuthStateChanged(auth, async user => {
  if (!user) return
  myUid = user.uid

  const userSnap    = await getDoc(doc(db, "users", myUid))
  const userData    = userSnap.data()
  const nickname    = userData?.nickname ?? myUid.slice(0, 6)
  const activeTitle = userData?.activeTitle ?? null
  myDisplayName     = activeTitle ? `[${activeTitle}] ${nickname}` : nickname
  isAdmin           = userData?.role === "admin"

  const adminPanel = document.getElementById("admin-panel")
  if (adminPanel) adminPanel.style.display = isAdmin ? "block" : "none"

  await joinRoom()
  listenRoom()
  setupButtons()
})

async function joinRoom() {
  const snap = await getDoc(roomRef)
  const room = snap.data()
  if (!room) return
  if (calcMySlot(room)) return

  if (room.game_started) { await joinAsSpectator(room); return }

  for (const slot of PLAYER_SLOTS) {
    if (!room[`${slot}_uid`]) {
      await updateDoc(roomRef, {
        [`${slot}_uid`]:  myUid,
        [`${slot}_name`]: myDisplayName
      })
      return
    }
  }
  await joinAsSpectator(room)
}

async function joinAsSpectator(room) {
  const spectators = room.spectators ?? []
  if (spectators.includes(myUid)) return
  await updateDoc(roomRef, {
    spectators:      [...spectators, myUid],
    spectator_names: [...(room.spectator_names ?? []), myDisplayName]
  })
}

function listenRoom() {
  onSnapshot(roomRef, async snap => {
    const room = snap.data()
    if (!room) return

    const mySlot = calcMySlot(room)

    // 플레이어 슬롯 UI
    PLAYER_SLOTS.forEach(slot => {
      const nameEl  = document.getElementById(slot)
      const readyEl = document.getElementById(`${slot}-ready`)
      const name    = room[`${slot}_name`]

      if (nameEl) {
        nameEl.textContent = name ?? "대기 중..."
        nameEl.classList.toggle('empty', !name)
      }
      if (readyEl) {
        const isReady = !!room[`${slot}_ready`]
        readyEl.textContent = isReady ? "준비 완료" : "대기"
        readyEl.classList.toggle('on', isReady)
      }
    })

    // 관전자
    const spectEl = document.getElementById("spectator-list")
    if (spectEl) {
      const names = room.spectator_names ?? []
      spectEl.textContent = names.length > 0 ? "관전자: " + names.join(", ") : "관전자 없음"
    }

    // 구역 변경 감지 → UI 동기화 (다른 사람이 바꿨을 때)
    if (room.selected_zone && typeof window.syncZoneUI === 'function') {
      window.syncZoneUI(room.selected_zone)
    }

    updateButtons(room, mySlot)
    if (isAdmin) renderAdminPanel(room)

    // 전원 레디 + 구역 선택 시 게임 시작
    const allReady = PLAYER_SLOTS.every(s => room[`${s}_ready`])
    if (allReady && room.selected_zone && !room.game_started && mySlot && mySlot !== "spectator") {
      await copyMyEntry(mySlot)

      if (mySlot === "player1") {
        let retries = 0
        while (retries < 10) {
          const freshSnap = await getDoc(roomRef)
          const freshRoom = freshSnap.data()
          const allUploaded = PLAYER_SLOTS.every(s => freshRoom[`${SLOT_TO_FS[s]}_entry`] !== null)
          if (allUploaded) {
            // 보스 데이터 복사 (boss/{bossId} → raid/{roomId})
            const bossId   = freshRoom.boss_id ?? null
            let bossUpdate = {}
            if (bossId) {
              const bossSnap = await getDoc(doc(db, "boss", bossId))
              const bossData = bossSnap.data()
              if (bossData) {
                bossUpdate = {
                  boss_name:       bossData.boss_name    ?? bossId,
                  boss_current_hp: bossData.hp           ?? 1000,
                  boss_max_hp:     bossData.hp           ?? 1000,
                  boss_attack:     bossData.attack       ?? 5,
                  boss_defense:    bossData.defense      ?? 5,
                  boss_speed:      bossData.speed        ?? 5,
                  boss_type:       bossData.type         ?? ["노말"],
                  boss_moves:      bossData.moves        ?? [],
                  boss_ult:        bossData.ult          ?? [],
                  boss_status:     null,
                  boss_rank:       { atk:0, atkTurns:0, def:0, defTurns:0, spd:0, spdTurns:0 },
                  boss_volatile:   {},
                  boss_state:      { phase1Step: "bite", repeatLeft: 0 },
                  boss_last_move:  null,
                  boss_last_attacker: null,
                  boss_damage_taken:  { p1: 0, p2: 0, p3: 0 },
                  boss_ult_cooldown:  0,
                }
              }
            }
            await updateDoc(roomRef, {
              ...bossUpdate,
              game_started:    true,
              game_started_at: Date.now(),
              round_count:     0,
              turn_count:      0,
              current_order:   [],
            })
            break
          }
          await new Promise(r => setTimeout(r, 500))
          retries++
        }
      }
    }

    // 게임 시작 → 배틀 화면 이동
    if (room.game_started && mySlot) {
      const allEntryReady = PLAYER_SLOTS.every(s => room[`${SLOT_TO_FS[s]}_entry`] !== null)
      if (!allEntryReady) return
      if (navigated) return
      navigated = true

      // selected_zone 기준으로 battleroom 결정
      const zoneData = typeof window.getZoneData === 'function' ? window.getZoneData() : {}
      const zoneInfo = zoneData[room.selected_zone]
      const roomFile = zoneInfo?.room ?? "battleroom1"

      const dest = mySlot === "spectator"
        ? `../games/${roomFile}.html?spectator=true`
        : `../games/${roomFile}.html`
      location.href = dest
    }
  })
}

// ── 구역 선택 (HTML에서 호출) ────────────────────────────────────────
window.setSelectedZone = async function(zoneKey) {
  const zoneData = typeof window.getZoneData === 'function' ? window.getZoneData() : {}
  const bossId   = zoneData[zoneKey]?.bossId ?? null
  await updateDoc(roomRef, { selected_zone: zoneKey, boss_id: bossId })
}

// ── 어드민 패널 ──────────────────────────────────────────────────────
let adminSelected = null

function slotLabel(slot) {
  const map = { player1: "P1", player2: "P2", player3: "P3" }
  return map[slot] ?? slot
}

function renderAdminPanel(room) {
  const grid = document.getElementById("admin-player-grid")
  if (!grid) return
  grid.innerHTML = ""

  PLAYER_SLOTS.forEach(slot => {
    const uid  = room[`${slot}_uid`]
    const name = room[`${slot}_name`] ?? "빈 자리"
    const isSelected = adminSelected?.type === "player" && adminSelected.slot === slot

    const btn = document.createElement("button")
    btn.className = "admin-slot-btn"
      + (isSelected ? " selected" : "")
      + (!uid ? " empty" : "")
    btn.innerHTML = `<span class="admin-slot-label">${slotLabel(slot)}</span><span class="admin-slot-name">${name}</span>`
    btn.onclick = () => onAdminClick({ type: "player", slot, uid, name }, room)
    grid.appendChild(btn)
  })

  const spectators     = room.spectators ?? []
  const spectatorNames = room.spectator_names ?? []
  spectators.forEach((uid, idx) => {
    const name = spectatorNames[idx] ?? uid.slice(0, 6)
    const isSelected = adminSelected?.type === "spectator" && adminSelected.uid === uid

    const btn = document.createElement("button")
    btn.className = "admin-slot-btn" + (isSelected ? " selected" : "")
    btn.innerHTML = `<span class="admin-slot-label">관전자</span><span class="admin-slot-name">${name}</span>`
    btn.onclick = () => onAdminClick({ type: "spectator", uid, name, idx }, room)
    grid.appendChild(btn)
  })

  const hint = document.getElementById("admin-hint")
  if (hint) {
    hint.textContent = !adminSelected
      ? "교체할 사람을 선택하세요"
      : `"${adminSelected.name}" 선택됨 → 교체할 대상 클릭 (같은 버튼 클릭 시 취소)`
  }
}

function onAdminClick(target, room) {
  if (!adminSelected) {
    if (target.type === "player" && !target.uid) return
    adminSelected = target
    renderAdminPanel(room)
    return
  }
  const isSame = adminSelected.type === target.type
    && (adminSelected.type === "player"
      ? adminSelected.slot === target.slot
      : adminSelected.uid  === target.uid)
  if (isSame) { adminSelected = null; renderAdminPanel(room); return }

  adminForceSwap(adminSelected, target, room)
  adminSelected = null
}

async function adminForceSwap(a, b, room) {
  const update = {}
  const spectators     = [...(room.spectators ?? [])]
  const spectatorNames = [...(room.spectator_names ?? [])]

  if (a.type === "player" && b.type === "player") {
    update[`${a.slot}_uid`]   = b.uid  ?? null
    update[`${a.slot}_name`]  = b.name ?? null
    update[`${a.slot}_ready`] = false
    update[`${b.slot}_uid`]   = a.uid  ?? null
    update[`${b.slot}_name`]  = a.name ?? null
    update[`${b.slot}_ready`] = false
  } else if (a.type === "player" && b.type === "spectator") {
    update[`${a.slot}_uid`]   = b.uid
    update[`${a.slot}_name`]  = b.name
    update[`${a.slot}_ready`] = false
    spectators.splice(b.idx, 1, a.uid)
    spectatorNames.splice(b.idx, 1, a.name)
    update.spectators      = spectators
    update.spectator_names = spectatorNames
  } else if (a.type === "spectator" && b.type === "player") {
    update[`${b.slot}_uid`]   = a.uid
    update[`${b.slot}_name`]  = a.name
    update[`${b.slot}_ready`] = false
    spectators.splice(a.idx, 1, b.uid)
    spectatorNames.splice(a.idx, 1, b.name)
    update.spectators      = spectators
    update.spectator_names = spectatorNames
  } else {
    spectators[a.idx]     = b.uid;  spectators[b.idx]     = a.uid
    spectatorNames[a.idx] = b.name; spectatorNames[b.idx] = a.name
    update.spectators      = spectators
    update.spectator_names = spectatorNames
  }

  await updateDoc(roomRef, update)
}

// ── 엔트리 복사 ──────────────────────────────────────────────────────
async function copyMyEntry(mySlot) {
  const fsSlot   = SLOT_TO_FS[mySlot]
  const userSnap = await getDoc(doc(db, "users", myUid))
  const entry    = userSnap.data()?.entry ?? []
  const entryWithMax = entry.map(p => ({ ...p, maxHp: p.hp }))
  await updateDoc(roomRef, {
    [`${fsSlot}_entry`]:      entryWithMax,
    [`${fsSlot}_active_idx`]: 0
  })
}

// ── 버튼 상태 ────────────────────────────────────────────────────────
function updateButtons(room, mySlot) {
  const isPlayer    = mySlot && mySlot !== "spectator"
  const isSpectator = mySlot === "spectator"

  const readyBtn = document.getElementById("readyBtn")
  const swapBtn  = document.getElementById("swapBtn")
  const leaveBtn = document.getElementById("leaveBtn")

  if (readyBtn) {
    readyBtn.style.display = isPlayer ? "inline-block" : "none"
    if (isPlayer) {
      const alreadyReady = !!room[`${mySlot}_ready`]
      readyBtn.disabled  = alreadyReady
      readyBtn.textContent = alreadyReady ? "Ready ✅" : "Ready"
    }
  }

  if (swapBtn) {
    const hasEmpty = PLAYER_SLOTS.some(s => !room[`${s}_uid`])
    swapBtn.style.display = isSpectator && hasEmpty && !room.game_started ? "inline-block" : "none"
  }

  if (leaveBtn) leaveBtn.disabled = isPlayer && !!room.game_started
}

// ── 버튼 이벤트 ──────────────────────────────────────────────────────
function setupButtons() {
  document.getElementById("readyBtn").onclick = async () => {
    const snap   = await getDoc(roomRef)
    const room   = snap.data()
    const mySlot = calcMySlot(room)
    if (!mySlot || mySlot === "spectator") return

    // 구역 미선택 체크
    if (!room.selected_zone) {
      const hintEl = typeof window.getZoneHintEl === 'function' ? window.getZoneHintEl() : null
      if (hintEl) hintEl.textContent = "구역을 먼저 선택해줘!"
      return
    }

    await updateDoc(roomRef, { [`${mySlot}_ready`]: true })
  }

  document.getElementById("leaveBtn").onclick = async () => {
    const snap   = await getDoc(roomRef)
    const room   = snap.data()
    const mySlot = calcMySlot(room)
    if (mySlot && mySlot !== "spectator" && room.game_started) {
      alert("도망칠 수 없다!"); return
    }
    await leaveRoom(mySlot, room)
  }

  const swapBtn = document.getElementById("swapBtn")
  if (swapBtn) {
    swapBtn.onclick = async () => {
      const snap = await getDoc(roomRef)
      const room = snap.data()
      for (const slot of PLAYER_SLOTS) {
        if (!room[`${slot}_uid`]) { await promoteToPlayer(slot, room); return }
      }
      alert("빈 자리가 없어요")
    }
  }
}

// ── 퇴장 ─────────────────────────────────────────────────────────────
async function leaveRoom(mySlot, room) {
  if (mySlot && mySlot !== "spectator") {
    const spectators     = room.spectators ?? []
    const spectatorNames = room.spectator_names ?? []
    if (spectators.length > 0) {
      const idx = Math.floor(Math.random() * spectators.length)
      await updateDoc(roomRef, {
        [`${mySlot}_uid`]:   spectators[idx],
        [`${mySlot}_name`]:  spectatorNames[idx],
        [`${mySlot}_ready`]: false,
        spectators:      spectators.filter((_, i) => i !== idx),
        spectator_names: spectatorNames.filter((_, i) => i !== idx)
      })
    } else {
      await updateDoc(roomRef, {
        [`${mySlot}_uid`]:   null,
        [`${mySlot}_name`]:  null,
        [`${mySlot}_ready`]: false
      })
    }
  } else {
    await updateDoc(roomRef, {
      spectators:      (room.spectators ?? []).filter(u => u !== myUid),
      spectator_names: (room.spectator_names ?? []).filter(n => n !== myDisplayName)
    })
  }
  location.href = "../main.html"
}

async function promoteToPlayer(targetSlot, room) {
  const spectators     = room.spectators ?? []
  const spectatorNames = room.spectator_names ?? []
  await updateDoc(roomRef, {
    [`${targetSlot}_uid`]:   myUid,
    [`${targetSlot}_name`]:  myDisplayName,
    spectators:      spectators.filter(u => u !== myUid),
    spectator_names: spectatorNames.filter(n => n !== myDisplayName)
  })
}