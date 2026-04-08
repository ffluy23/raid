// chat.js - 더블배틀 팀별 격리 채팅
import {
  collection, addDoc, onSnapshot, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"

function getChatChannel(mySlot, isSpectator) {
  if (isSpectator || !mySlot) return "spectator"
  if (mySlot === "p1" || mySlot === "p2") return "teamA"
  if (mySlot === "p3" || mySlot === "p4") return "teamB"
  return "spectator"
}

function formatMessage(text) {
  return text.replace(/\((.+?)\)/g, '<span class="chat-action">($1)</span>')
}

function appendMessage(container, nickname, text) {
  const div = document.createElement("div")
  div.className = "chat-message"
  div.innerHTML = `<span class="chat-nick">${nickname}:</span> ${formatMessage(text)}`
  container.appendChild(div)
  container.scrollTop = container.scrollHeight
}

function subscribeChannel(db, ROOM_ID, channel, gameStartedAt, rendered, container) {
  const ref = collection(db, "double", ROOM_ID, `chat_${channel}`)
  const q = gameStartedAt > 0
    ? query(ref, orderBy("ts"), where("ts", ">=", gameStartedAt))
    : query(ref, orderBy("ts"))

  return onSnapshot(q, snap => {
    const newDocs = []
    snap.docs.forEach(d => {
      if (rendered.has(d.id)) return
      rendered.add(d.id)
      newDocs.push({ id: d.id, ...d.data() })
    })
    newDocs.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    newDocs.forEach(({ nickname, text }) => appendMessage(container, nickname, text))
  })
}

window.initDoubleChat = function({ db, ROOM_ID, myUid, mySlot, isSpectator, gameStartedAt = 0 }) {
  const channel   = getChatChannel(mySlot, isSpectator)
  const container = document.getElementById("chat-messages")
  if (!container) return

  const labelEl  = document.getElementById("chat-channel-label")
  const labelMap = { teamA: "🔵 팀A 채팅", teamB: "🔴 팀B 채팅" }
  if (labelEl) labelEl.innerText = isSpectator ? "채팅" : (labelMap[channel] ?? "채팅")

  const rendered = new Set()

  if (isSpectator) {
    // 기존 팀 채팅 숨기고 관전자 섹션 표시
    const chatSection = document.getElementById("chat-section")
    if (chatSection) chatSection.style.display = "none"
    const spectatorSection = document.getElementById("spectator-chat-section")
    if (spectatorSection) spectatorSection.style.display = "block"

    // 팀A, 팀B 구독 (읽기만)
    const containerA = document.getElementById("spectator-chat-a")
    const containerB = document.getElementById("spectator-chat-b")
    if (containerA) subscribeChannel(db, ROOM_ID, "teamA", gameStartedAt, new Set(), containerA)
    if (containerB) subscribeChannel(db, ROOM_ID, "teamB", gameStartedAt, new Set(), containerB)

    // 관전자 채팅 구독 + 전송
    const spectatorContainer = document.getElementById("spectator-chat-messages")
    if (spectatorContainer) subscribeChannel(db, ROOM_ID, "spectator", gameStartedAt, new Set(), spectatorContainer)

    async function sendSpectatorChat() {
      const input = document.getElementById("spectator-chat-input")
      if (!input) return
      const text = input.value.trim()
      if (!text) return
      const nickname = window.__myDisplayName ?? myUid.slice(0, 6)
      const ref = collection(db, "double", ROOM_ID, "chat_spectator")
      await addDoc(ref, { uid: myUid, nickname, text, ts: Date.now() })
      input.value = ""
    }

    const sendBtn = document.getElementById("spectator-chat-send-btn")
    if (sendBtn) sendBtn.onclick = sendSpectatorChat

    const inputEl = document.getElementById("spectator-chat-input")
    if (inputEl) inputEl.addEventListener("keypress", e => { if (e.key === "Enter") sendSpectatorChat() })

  } else {
    subscribeChannel(db, ROOM_ID, channel, gameStartedAt, rendered, container)

    async function sendChat() {
      const input = document.getElementById("chat-input")
      if (!input) return
      const text = input.value.trim()
      if (!text) return
      const nickname = window.__myDisplayName ?? myUid.slice(0, 6)
      const ref = collection(db, "double", ROOM_ID, `chat_${channel}`)
      await addDoc(ref, { uid: myUid, nickname, text, ts: Date.now() })
      input.value = ""
    }

    const sendBtn = document.getElementById("chat-send-btn")
    if (sendBtn) sendBtn.onclick = sendChat

    const inputEl = document.getElementById("chat-input")
    if (inputEl) inputEl.addEventListener("keypress", e => { if (e.key === "Enter") sendChat() })
  }
}