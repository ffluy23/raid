// js/doubleintro.js

import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import { doc, getDoc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"

const BGM_URL = "https://exceptional-salmon-nww9g1qxa5.edgeone.app/Vs.%20Marnie%20Remix%20-%20Pokemon%20Sword%20and%20Shield.mp3"

const BG_LIST = [
  "https://foolish-rose-9l9aoow1vy.edgeone.app/배경1%20(1).jpg",
  "https://old-olive-m53ztzpdmh.edgeone.app/배경2%20(1).jpg",
  "https://driving-moccasin-bfvl5nk24u.edgeone.app/배경3%20(1).jpg",
  "https://yielding-green-qv9brnrm3e.edgeone.app/배경4.jpg",
  "https://tricky-gold-ws4fc7rxqb.edgeone.app/배경5.jpg",
  "https://geographical-black-tvekomtcvt.edgeone.app/배경6.jpg"
]

export let bgmAudio = null
let bgApplied = false

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

function applyBackground(url) {
  document.body.style.backgroundImage = `url('${url}')`
  document.body.style.backgroundSize = "cover"
  document.body.style.backgroundPosition = "center"
  document.body.style.backgroundRepeat = "no-repeat"
}

const overlay     = document.getElementById("intro-overlay")
const touchScreen = document.getElementById("touch-screen")
const readyStatus = document.getElementById("touch-ready-status")
const vsScreen    = document.getElementById("vs-screen")
const roomRef     = doc(db, "double", ROOM_ID)

const isSpectatorParam = new URLSearchParams(location.search).get("spectator") === "true"

let myUid         = null
let mySlot        = null
let touched       = false
let introDone     = false   // 내 인트로 5초가 끝났는지
let allReady      = false   // p1~p4 모두 ready인지 (한번 true되면 유지)

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

// 슬롯 → p1~p4 매핑
function resolveMySlot(data, uid) {
  for (const s of ["p1", "p2", "p3", "p4"]) {
    const key = s.replace("p", "player") + "_uid"
    if (data[key] === uid) return s
  }
  return null
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return
  myUid = user.uid

  if (isSpectatorParam) {
    skipIntro()
    return
  }

  const snap = await getDoc(roomRef)
  const room = snap.data()
  mySlot = resolveMySlot(room, myUid)

  // 인트로가 이미 끝난 상태 → 스킵
  if (room?.intro_done) {
    skipIntro()
    return
  }

  bindTouch()
  listenReady()
})

function bindTouch() {
  const handler = () => {
    if (touched) return
    touched = true
    document.removeEventListener("click",      handler)
    document.removeEventListener("touchstart", handler)
    onTouched()
  }
  document.addEventListener("click",      handler)
  document.addEventListener("touchstart", handler)
}

async function onTouched() {
  // BGM — 터치 컨텍스트 안에서 재생
  bgmAudio = new Audio(BGM_URL)
  bgmAudio.loop   = true
  bgmAudio.volume = 0.7
  bgmAudio.play().catch(() => {})

  const snap = await getDoc(roomRef)
  const room = snap.data()

  // 배경 처리: p1이 결정권, 나머지는 수신
  if (!bgApplied) {
    if (mySlot === "p1") {
      const bgUrl = BG_LIST[Math.floor(Math.random() * BG_LIST.length)]
      await updateDoc(roomRef, { background: bgUrl })
      applyBackground(bgUrl)
      bgApplied = true
    } else if (room?.background) {
      applyBackground(room.background)
      bgApplied = true
    }
  }

  // VS 인트로 재생
  playVsIntro(room)

  // Firestore에 내 ready 마킹
  const field = `intro_ready_${mySlot}`
  await updateDoc(roomRef, { [field]: true })
}

function listenReady() {
  onSnapshot(roomRef, (snap) => {
    const room = snap.data()
    if (!room) return

    // 배경 감지 (늦게 접속한 경우)
    if (room.background && !bgApplied) {
      bgApplied = true
      applyBackground(room.background)
    }

    // 4명 모두 ready인지 확인
    const r1 = !!room.intro_ready_p1
    const r2 = !!room.intro_ready_p2
    const r3 = !!room.intro_ready_p3
    const r4 = !!room.intro_ready_p4
    if (r1 && r2 && r3 && r4) allReady = true

    // 대기 메시지 업데이트
    if (touched && !allReady) {
      const readyCount = [r1, r2, r3, r4].filter(Boolean).length
      if (readyStatus) readyStatus.innerText = `상대방을 기다리는 중... (${readyCount}/4)`
    }

    // 내 인트로가 끝난 상태에서 전원 ready → 배틀 시작
    if (allReady && introDone) startBattle()
  })
}

async function playVsIntro(room) {
  // 팀A: p1+p2 이름, 팀B: p3+p4 이름
  const p1 = (room.player1_name ?? "PLAYER1").toUpperCase()
  const p2 = (room.player2_name ?? "PLAYER2").toUpperCase()
  const p3 = (room.player3_name ?? "PLAYER3").toUpperCase()
  const p4 = (room.player4_name ?? "PLAYER4").toUpperCase()

  const leftEl  = document.getElementById("vs-name-left")
  const rightEl = document.getElementById("vs-name-right")
  const subLeftEl  = document.getElementById("vs-name-sub-left")
  const subRightEl = document.getElementById("vs-name-sub-right")

  if (leftEl)     leftEl.textContent  = p1
  if (subLeftEl)  subLeftEl.textContent  = `& ${p2}`
  if (rightEl)    rightEl.textContent = p3
  if (subRightEl) subRightEl.textContent = `& ${p4}`

  if (touchScreen) touchScreen.style.display = "none"
  if (vsScreen) vsScreen.classList.add("show")

  await wait(50)

  const flash      = document.getElementById("vs-flash")
  const burst      = document.getElementById("vs-burst")
  const vsLeft     = document.getElementById("vs-left")
  const vsRight    = document.getElementById("vs-right")
  const vsLabel    = document.getElementById("vs-label")
  const innerLeft  = document.getElementById("vs-inner-left")
  const innerRight = document.getElementById("vs-inner-right")

  if (flash)   flash.classList.add("show")
  await wait(100)
  if (vsLeft)  vsLeft.classList.add("show")
  await wait(100)
  if (vsRight) vsRight.classList.add("show")
  await wait(250)
  if (vsLabel) vsLabel.classList.add("show")
  if (flash)   flash.classList.add("show")
  if (burst)   burst.classList.add("show")
  if (vsScreen) vsScreen.classList.add("vs-shake")
  await wait(450)
  if (innerLeft)  innerLeft.classList.add("drift-left")
  if (innerRight) innerRight.classList.add("drift-right")

  // 5초 인트로 대기
  await wait(5000)
  introDone = true

  if (allReady) {
    startBattle()
  } else {
    if (vsScreen) vsScreen.style.opacity = "0.3"
    if (readyStatus) {
      readyStatus.style.cssText = "color:white; font-size:clamp(1rem,3vw,1.4rem); position:absolute; bottom:10vh; width:100%; text-align:center; z-index:10;"
      readyStatus.innerText = "상대방을 기다리는 중..."
    }
  }
}

async function startBattle() {
  if (!overlay || overlay.classList.contains("fade-out")) return
  overlay.classList.add("fade-out")
  const battleScreen = document.getElementById("battle-screen")
  if (battleScreen) battleScreen.style.opacity = "1"

  // p1만 game_started_at 기록 (채팅 필터 기준점)
  if (mySlot === "p1") {
    await updateDoc(roomRef, { game_started_at: Date.now(), intro_done: true })
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
    if (label) label.innerText = Math.round(v * 100) + "%"
  })
}

async function skipIntro() {
  if (overlay) overlay.classList.add("hidden")
  const battleScreen = document.getElementById("battle-screen")
  if (battleScreen) battleScreen.style.opacity = "1"
  initVolumeSlider()

  // 배경 복원
  const snap = await getDoc(roomRef)
  const room = snap.data()
  if (room?.background && !bgApplied) {
    bgApplied = true
    applyBackground(room.background)
  }

  // BGM 복원 (데스크탑 바로 시도)
  const testAudio = new Audio(BGM_URL)
  testAudio.loop   = true
  testAudio.volume = 0.7
  testAudio.play().then(() => {
    bgmAudio = testAudio
  }).catch(() => {
    showBgmToast()
  })

  setTimeout(() => {
    if (!bgmAudio || bgmAudio.paused) showBgmToast()
  }, 500)
}

function showBgmToast() {
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
  btn.innerText = "🎵 탭하여 브금 재생"

  btn.onclick = () => {
    bgmAudio = new Audio(BGM_URL)
    bgmAudio.loop   = true
    bgmAudio.volume = 0.7
    bgmAudio.play().catch(() => {})
    btn.remove()
  }

  document.body.appendChild(btn)
  setTimeout(() => btn.remove(), 10000)
}