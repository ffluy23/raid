// js/item.js
// 레이드 배틀 중 아이템 사용 모달 & 로직
// raid.js에서 import해서 사용
// 필요한 전역: ROOM_ID, mySlot, myTurn, actionDone, API

// ── 아이템 정의 (서버와 동기화) ──────────────────────────────────────
export const ITEM_DEFS = {
  "회복약": {
    name:  "회복약",
    icon:  "🧪",
    desc:  "모든 상태이상을 없애고 HP를 완전히 회복",
    // 살아있는 포켓몬에만 사용 가능
    canUse: (pkmn) => pkmn.hp > 0,
    targetLabel: "회복할 포켓몬 선택",
  },
  "기력의덩어리": {
    name:  "기력의덩어리",
    icon:  "💎",
    desc:  "기절한 포켓몬을 HP 가득 채워서 부활",
    // 기절한 포켓몬에만 사용 가능
    canUse: (pkmn) => pkmn.hp <= 0,
    targetLabel: "부활시킬 포켓몬 선택",
  },
}

// ── 모달 열기 ────────────────────────────────────────────────────────
/**
 * @param {object} roomData  - 현재 룸 스냅샷 데이터
 * @param {string} slot      - 내 슬롯 ("p1"/"p2"/"p3")
 * @param {boolean} isTurn   - 내 턴 여부
 * @param {boolean} done     - 이미 행동했는지 여부
 * @param {Function} onUse   - 실제 사용 콜백 (itemName, targetIdx) => void
 */
export function openItemModal(roomData, slot, isTurn, done, onUse) {
  // 이미 모달 있으면 제거
  closeItemModal()

  const inventory = roomData.inventory ?? {}
  const myEntry   = roomData[`${slot}_entry`] ?? []

  // 사용 가능 여부
  const canAct = isTurn && !done

  // ── 모달 오버레이 생성 ─────────────────────────────────────────
  const overlay = document.createElement("div")
  overlay.id    = "item-modal-overlay"
  overlay.style.cssText = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center;
    z-index: 9999;
  `
  overlay.addEventListener("click", e => { if (e.target === overlay) closeItemModal() })

  // ── 모달 박스 ─────────────────────────────────────────────────
  const modal = document.createElement("div")
  modal.style.cssText = `
    background: #1e1e2e;
    border: 2px solid #444;
    border-radius: 14px;
    padding: 20px 24px;
    min-width: 300px;
    max-width: 380px;
    width: 90vw;
    color: #eee;
    font-family: inherit;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  `

  // 헤더
  const header = document.createElement("div")
  header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;"
  header.innerHTML = `
    <span style="font-size:17px;font-weight:bold;">🎒 가방</span>
    <button id="item-modal-close" style="background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;line-height:1;">✕</button>
  `
  modal.appendChild(header)

  // 인벤토리가 비어있으면
  const hasAnyItem = Object.values(inventory).some(v => v > 0)
  if (!hasAnyItem) {
    const empty = document.createElement("p")
    empty.style.cssText = "text-align:center;color:#888;margin:16px 0;"
    empty.innerText = "아이템이 없다!"
    modal.appendChild(empty)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    document.getElementById("item-modal-close").onclick = closeItemModal
    return
  }

  // ── 아이템 목록 ───────────────────────────────────────────────
  const itemList = document.createElement("div")
  itemList.style.cssText = "display:flex;flex-direction:column;gap:10px;"

  Object.entries(ITEM_DEFS).forEach(([itemName, def]) => {
    const count = inventory[itemName] ?? 0
    if (count <= 0) return

    const row = document.createElement("div")
    row.style.cssText = `
      background: #2a2a3e;
      border-radius: 10px;
      padding: 12px 14px;
      border: 1px solid #3a3a5c;
    `

    // 아이템 헤더
    const rowHead = document.createElement("div")
    rowHead.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"
    rowHead.innerHTML = `
      <span style="font-size:15px;font-weight:bold;">${def.icon} ${def.name}</span>
      <span style="font-size:13px;color:#aaa;">× ${count}</span>
    `
    row.appendChild(rowHead)

    const desc = document.createElement("p")
    desc.style.cssText = "font-size:12px;color:#999;margin:0 0 10px;"
    desc.innerText = def.desc
    row.appendChild(desc)

    if (!canAct) {
      const notice = document.createElement("p")
      notice.style.cssText = "font-size:12px;color:#e67e22;margin:0;"
      notice.innerText = isTurn ? "이미 행동했다!" : "내 턴이 아니다!"
      row.appendChild(notice)
      itemList.appendChild(row)
      return
    }

    // ── 포켓몬 선택 버튼 ──────────────────────────────────────
    const targetLabel = document.createElement("p")
    targetLabel.style.cssText = "font-size:12px;color:#ccc;margin:0 0 6px;"
    targetLabel.innerText = def.targetLabel
    row.appendChild(targetLabel)

    const btnGroup = document.createElement("div")
    btnGroup.style.cssText = "display:flex;flex-direction:column;gap:6px;"

    myEntry.forEach((pkmn, idx) => {
      const canTarget = def.canUse(pkmn)
      const hpText    = pkmn.hp <= 0 ? "기절" : `HP: ${pkmn.hp}/${pkmn.maxHp}`

      const btn = document.createElement("button")
      btn.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        border-radius: 8px;
        border: none;
        font-size: 13px;
        font-family: inherit;
        cursor: ${canTarget ? "pointer" : "not-allowed"};
        background: ${canTarget ? "#3a5a3a" : "#333"};
        color: ${canTarget ? "#9eff9e" : "#666"};
        transition: background 0.15s;
      `
      btn.innerHTML = `
        <span>${pkmn.name}</span>
        <span style="font-size:11px;opacity:.85;">${hpText}</span>
      `
      btn.disabled = !canTarget

      if (canTarget) {
        btn.addEventListener("mouseenter", () => { btn.style.background = "#4a7a4a" })
        btn.addEventListener("mouseleave", () => { btn.style.background = "#3a5a3a" })
        btn.onclick = () => {
          closeItemModal()
          onUse(itemName, idx)
        }
      }
      btnGroup.appendChild(btn)
    })

    row.appendChild(btnGroup)
    itemList.appendChild(row)
  })

  modal.appendChild(itemList)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  document.getElementById("item-modal-close").onclick = closeItemModal

  // ESC로 닫기
  const onKeyDown = (e) => { if (e.key === "Escape") closeItemModal() }
  overlay._onKeyDown = onKeyDown
  document.addEventListener("keydown", onKeyDown)
}

// ── 모달 닫기 ────────────────────────────────────────────────────────
export function closeItemModal() {
  const overlay = document.getElementById("item-modal-overlay")
  if (!overlay) return
  if (overlay._onKeyDown) document.removeEventListener("keydown", overlay._onKeyDown)
  overlay.remove()
}

// ── 인벤토리 요약 표시 (가방 버튼 옆 배지용) ─────────────────────────
/**
 * 전체 아이템 개수 반환
 * @param {object} inventory - roomData.inventory
 */
export function getTotalItemCount(inventory = {}) {
  return Object.values(inventory).reduce((sum, v) => sum + (v > 0 ? v : 0), 0)
}

/**
 * 가방 버튼 배지 업데이트
 * @param {string} btnId     - 버튼 element id
 * @param {object} inventory - roomData.inventory
 */
export function updateBagBadge(btnId, inventory = {}) {
  const btn = document.getElementById(btnId)
  if (!btn) return
  const total  = getTotalItemCount(inventory)
  let badge    = btn.querySelector(".bag-badge")
  if (total <= 0) {
    if (badge) badge.remove()
    return
  }
  if (!badge) {
    badge = document.createElement("span")
    badge.className   = "bag-badge"
    badge.style.cssText = `
      position: absolute;
      top: -6px; right: -6px;
      background: #e74c3c;
      color: white;
      font-size: 10px;
      font-weight: bold;
      border-radius: 999px;
      padding: 1px 5px;
      pointer-events: none;
      line-height: 1.4;
    `
    btn.style.position = "relative"
    btn.appendChild(badge)
  }
  badge.innerText = total
}