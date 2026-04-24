// js/raidintro.js
import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import { doc, getDoc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"

const roomRef = doc(db, "raid", ROOM_ID)
const isSpectator = new URLSearchParams(location.search).get("spectator") === "true"

export let bgmAudio = null
let bgApplied = false
let myUid     = null
let mySlot    = null
let touched   = false

const PLAYER_SLOTS = ["p1", "p2", "p3"]

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

export function fadeBgmOut(duration = 2000) {
  if (!bgmAudio) return
  const step = bgmAudio.volume / (duration / 50)
  const timer = setInterval(() => {
    if (bgmAudio.volume > step) {
      bgmAudio.volume = Math.max(0, bgmAudio.volume - step)
    } else {
      bgmAudio.volume = 0
      bgmAudio.pause()
      clearInterval(timer)
    }
  }, 50)
}

function resolveMySlot(data, uid) {
  for (const s of PLAYER_SLOTS) {
    const key = s.replace("p", "player") + "_uid"
    if (data[key] === uid) return s
  }
  return null
}

// ── 보스 데이터 로드 ────────────────────────────────────────────────
async function loadBossData(bossName) {
  if (!bossName) return null
  try {
    const snap = await getDoc(doc(db, "boss", bossName))
    return snap.exists() ? snap.data() : null
  } catch (e) {
    console.warn("보스 데이터 로드 실패:", e)
    return null
  }
}

const RAID_BG = "https://urgent-amethyst-ykrwrgxwfi.edgeone.app/%EB%A0%88%EC%9D%B4%EB%93%9C%20%EB%92%B7%EB%B0%B0%EA%B2%BD.jpg"

function applyBossPortrait(portraitUrl) {
  if (!portraitUrl) return
  const img = document.getElementById("boss-portrait")
  if (img) {
    img.src = portraitUrl
    img.style.display = "block"
    setTimeout(() => img.classList.add("visible"), 80)
    const ph = img.previousElementSibling
    if (ph) ph.style.display = "none"
  }
  if (!bgApplied) {
    document.body.style.backgroundImage = `url('${RAID_BG}')`
    document.body.style.backgroundSize = "cover"
    document.body.style.backgroundPosition = "center"
    document.body.style.backgroundRepeat = "no-repeat"
    bgApplied = true
  }
}

function startBgm(url) {
  if (!url) return
  bgmAudio = new Audio(url)
  bgmAudio.loop   = true
  bgmAudio.volume = 0.7
  bgmAudio.play().catch(() => showBgmToast(url))
}

// ── 인트로 시작 ─────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (!user) return
  myUid = user.uid

  if (isSpectator) {
    await skipIntro()
    return
  }

  const snap = await getDoc(roomRef)
  if (!snap.exists()) {
    console.warn("raid 문서 없음:", ROOM_ID)
    await skipIntro()
    return
  }
  const room = snap.data()
  mySlot = resolveMySlot(room, myUid)

  if (room?.intro_done) {
    await skipIntro()
    return
  }

  bindTouch()
  listenReady()
})

function bindTouch() {
  const overlay = document.getElementById("intro-overlay")
  if (!overlay) return
  overlay.addEventListener("click", async () => {
    if (touched) return
    touched = true
    await onTouched()
  }, { once: true })
}

async function onTouched() {
  const snap     = await getDoc(roomRef)
  const room     = snap.data()
  const bossId   = room?.boss_id   ?? null
  const bossData = await loadBossData(bossId)

  // BGM — 터치 컨텍스트 안에서 재생
  if (bossData?.bgm) startBgm(bossData.bgm)

  // 보스 초상화 + 배경
  // p1만 방 문서 초기화 담당
  if (bossData?.portrait) {
    if (mySlot === "p1") {
      const introUpdate = { boss_portrait_url: bossData.portrait }
      // boss/kangaskhan 문서에 baby 필드가 있으면 raid 방 문서에도 세팅
      // (아기 캥카가 처음부터 UI에 표시되려면 boss_baby가 방 문서에 있어야 함)
      if (bossData.baby) introUpdate.boss_baby = bossData.baby
      await updateDoc(roomRef, introUpdate)
    }
    applyBossPortrait(bossData.portrait)
  }

  // Firestore에 내 인트로 ready 마킹
  if (mySlot) {
    await updateDoc(roomRef, { [`intro_ready_${mySlot}`]: true })
  } else {
    await skipIntro()
    return
  }

  // 상태 메시지
  const prompt = document.getElementById("touch-prompt")
  if (prompt) prompt.textContent = "상대방을 기다리는 중..."
}

function listenReady() {
  onSnapshot(roomRef, snap => {
    const room = snap.data()
    if (!room) return

    if (room.boss_portrait_url && !bgApplied) {
      applyBossPortrait(room.boss_portrait_url)
    }

    const readyCount = PLAYER_SLOTS.filter(s => room[`intro_ready_${s}`]).length
    const allReady   = readyCount >= PLAYER_SLOTS.length

    if (touched) {
      const prompt = document.getElementById("touch-prompt")
      if (prompt && !allReady) prompt.textContent = `대기 중... (${readyCount}/${PLAYER_SLOTS.length})`
    }

    if (allReady) startBattle(room)
  })
}

async function startBattle(room) {
  const overlay = document.getElementById("intro-overlay")
  if (!overlay || overlay.classList.contains("fade-out")) return

  overlay.classList.add("fade-out")
  const battleScreen = document.getElementById("battle-screen")
  if (battleScreen) battleScreen.style.opacity = "1"

  if (mySlot === "p1") {
    await updateDoc(roomRef, {
      game_started_at: Date.now(),
      intro_done:      true,
    })
  }

  setTimeout(() => {
    overlay.classList.add("hidden")
    initVolumeSlider()
  }, 800)
}

function initVolumeSlider() {
  const slider = document.getElementById("bgm-volume")
  const label  = document.getElementById("bgm-volume-label")
  if (!slider) return
  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value)
    if (bgmAudio) bgmAudio.volume = v
    if (label) label.textContent = Math.round(v * 100) + "%"
  })
}

async function skipIntro() {
  const overlay = document.getElementById("intro-overlay")
  if (overlay) overlay.classList.add("hidden")
  const battleScreen = document.getElementById("battle-screen")
  if (battleScreen) battleScreen.style.opacity = "1"
  initVolumeSlider()

  const snap     = await getDoc(roomRef)
  const room     = snap.data()
  const bossId   = room?.boss_id   ?? null
  const bossData = await loadBossData(bossId)

  if (bossData?.portrait) applyBossPortrait(bossData.portrait)
  if (!bgApplied) {
    document.body.style.backgroundImage = `url('${RAID_BG}')`
    document.body.style.backgroundSize = "cover"
    document.body.style.backgroundPosition = "center"
    document.body.style.backgroundRepeat = "no-repeat"
    bgApplied = true
  }

  if (bossData?.bgm) {
    const audio = new Audio(bossData.bgm)
    audio.loop   = true
    audio.volume = 0.7
    audio.play().then(() => { bgmAudio = audio }).catch(() => showBgmToast(bossData.bgm))
    setTimeout(() => { if (!bgmAudio || bgmAudio.paused) showBgmToast(bossData.bgm) }, 500)
  }
}

function showBgmToast(url) {
  if (document.getElementById("bgm-toast")) return
  if (!document.getElementById("bgm-toast-style")) {
    const s = document.createElement("style")
    s.id = "bgm-toast-style"
    s.textContent = `
      @keyframes fadeInUp {
        from { opacity:0; transform:translateX(-50%) translateY(10px) }
        to   { opacity:1; transform:translateX(-50%) translateY(0) }
      }
      #bgm-toast {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.8); color: #fff;
        padding: 12px 24px; border-radius: 999px;
        font-size: 14px; z-index: 9999;
        border: none; cursor: pointer;
        animation: fadeInUp 0.3s ease;
        white-space: nowrap;
      }
    `
    document.head.appendChild(s)
  }
  const btn = document.createElement("button")
  btn.id = "bgm-toast"
  btn.textContent = "🎵 탭하여 브금 재생"
  btn.onclick = () => {
    bgmAudio = new Audio(url)
    bgmAudio.loop   = true
    bgmAudio.volume = 0.7
    bgmAudio.play().catch(() => {})
    btn.remove()
  }
  document.body.appendChild(btn)
  setTimeout(() => btn.remove(), 10000)
}