// weather.js
// 날씨 시스템 — 더블 배틀용
// Firestore 필드: weather (string|null), weatherTurns (int)

import { josa } from "./effecthandler.js"

// ────────────────────────────────────────────
//  날씨 시작 처리
// ────────────────────────────────────────────
export function startWeather(newWeather, turns, prevWeather, allPokemon) {
  const msgs = []

  // 이전 날씨가 모래바람이었으면 방어 부스트 제거
  if (prevWeather === "모래바람" && newWeather !== "모래바람") {
    for (const p of allPokemon) {
      if (p && p.weatherDefBoost && p.hp > 0) {
        const base = p.defense ?? 3
        if (p.ranks) {
          p.ranks.def = Math.max(base, (p.ranks.def ?? base) - 2)
          p.ranks.defTurns = 0
        }
        p.weatherDefBoost = false
      }
    }
  }

  const firstLog = {
    "쾌청":     "햇살이 강해졌다!",
    "비":       "비가 내리기 시작했다!",
    "모래바람": "모래바람이 불기 시작했다!",
    "싸라기눈": "싸라기눈이 내리기 시작했다!",
  }[newWeather] ?? `${newWeather} 날씨가 시작됐다!`
  msgs.push(firstLog)

  // 모래바람: 바위 타입 방어 +2
  if (newWeather === "모래바람") {
    for (const p of allPokemon) {
      if (!p || p.hp <= 0) continue
      const types = Array.isArray(p.type) ? p.type : [p.type]
      if (types.includes("바위") && !p.weatherDefBoost) {
        const base = p.defense ?? 3
        if (!p.ranks) p.ranks = { atk: p.attack ?? 3, atkTurns: 0, def: base, defTurns: 0, spd: p.speed ?? 3, spdTurns: 0 }
        const prev = (p.ranks.defTurns ?? 0) > 0 ? (p.ranks.def ?? base) : base
        p.ranks.def = Math.min(base + 3, prev + 2)
        p.ranks.defTurns = 999
        p.weatherDefBoost = true
        msgs.push(`${p.name}${josa(p.name, "의")} 모래바람으로 방어가 올랐다!`)
      }
    }
  }

  return { msgs, weather: newWeather, weatherTurns: turns }
}

// ────────────────────────────────────────────
//  날씨 지속 로그
// ────────────────────────────────────────────
export function getWeatherLog(weather) {
  return {
    "쾌청":     "햇살이 강하다",
    "비":       "비가 계속 내리고 있다",
    "모래바람": "모래바람이 계속 불고 있다",
    "싸라기눈": "싸라기눈이 계속 내리고 있다",
  }[weather] ?? null
}

// ────────────────────────────────────────────
//  날씨 EOT 데미지 — 더블용 (활성 포켓몬 4마리)
//  activePokemons: [{ pokemon, slot }, ...]
// ────────────────────────────────────────────
export function applyWeatherDamage(weather, activePokemons) {
  const msgs = []
  let anyFainted = false

  if (weather !== "모래바람" && weather !== "싸라기눈") {
    return { msgs, anyFainted }
  }

  const immune = weather === "모래바람"
    ? ["바위", "땅", "강철"]
    : ["얼음"]

  const damageLabel = weather === "모래바람" ? "모래바람이" : "싸라기눈이"

  for (const { pokemon, slot } of activePokemons) {
    if (!pokemon || pokemon.hp <= 0) continue
    const types = Array.isArray(pokemon.type) ? pokemon.type : [pokemon.type]
    if (types.some(t => immune.includes(t))) continue

    const dmg = Math.max(1, Math.floor((pokemon.maxHp ?? pokemon.hp) / 16))
    pokemon.hp = Math.max(0, pokemon.hp - dmg)
    msgs.push({ type: "normal", text: `${damageLabel} ${pokemon.name}${josa(pokemon.name, "을를")} 덮쳤다!` })
    msgs.push({ type: "hp", text: "", meta: { slot, hp: pokemon.hp, maxHp: pokemon.maxHp ?? pokemon.hp } })
    if (pokemon.hp <= 0) {
      msgs.push({ type: "faint", text: `${pokemon.name}${josa(pokemon.name, "은는")} 쓰러졌다!`, meta: { slot } })
      anyFainted = true
    }
  }

  return { msgs, anyFainted }
}

// ────────────────────────────────────────────
//  날씨 턴 감소
// ────────────────────────────────────────────
export function tickWeather(weatherTurns) {
  const next = (weatherTurns ?? 0) - 1
  return { expired: next <= 0, weatherTurns: Math.max(0, next) }
}

// ────────────────────────────────────────────
//  날씨 종료 처리
// ────────────────────────────────────────────
export function endWeather(prevWeather, allPokemon) {
  const msgs = []
  if (prevWeather === "모래바람") {
    for (const p of allPokemon) {
      if (p && p.weatherDefBoost) {
        const base = p.defense ?? 3
        if (p.ranks) {
          p.ranks.def = Math.max(base, (p.ranks.def ?? base) - 2)
          p.ranks.defTurns = 0
        }
        p.weatherDefBoost = false
      }
    }
  }
  const endLog = {
    "쾌청":     "햇살이 약해졌다",
    "비":       "비가 그쳤다",
    "모래바람": "모래바람이 가라앉았다",
    "싸라기눈": "싸라기눈이 그쳤다",
  }[prevWeather]
  if (endLog) msgs.push({ type: "normal", text: endLog })
  return { msgs, weather: null, weatherTurns: 0 }
}

// ────────────────────────────────────────────
//  날씨 데미지 배율
// ────────────────────────────────────────────
export function getWeatherDamageMult(weather, moveType) {
  if (!weather || !moveType) return 1.0
  if (weather === "쾌청") {
    if (moveType === "불") return 1.2
    if (moveType === "물") return 0.8
  }
  if (weather === "비") {
    if (moveType === "물") return 1.2
    if (moveType === "불") return 0.8
  }
  return 1.0
}

// ────────────────────────────────────────────
//  쾌청: 성장 공격 랭크 보정값
// ────────────────────────────────────────────
export function getSunnyGrowthBonus(weather) {
  return weather === "쾌청" ? 2 : 1
}

// ────────────────────────────────────────────
//  날씨에 따른 기술 패치 (번개, 눈보라)
// ────────────────────────────────────────────
export function patchMoveForWeather(weather, moveName, moveInfo) {
  if (!moveInfo) return moveInfo
  if (moveName === "번개") {
    if (weather === "비")   return { ...moveInfo, alwaysHit: true,  accuracy: 100 }
    if (weather === "쾌청") return { ...moveInfo, alwaysHit: false, accuracy: 50  }
  }
  if (moveName === "눈보라") {
    if (weather === "싸라기눈") return { ...moveInfo, alwaysHit: true, accuracy: 100 }
  }
  return moveInfo
}

// ────────────────────────────────────────────
//  쾌청: 얼음 면역 체크
// ────────────────────────────────────────────
export function isFrozenImmuneByWeather(weather, status) {
  return weather === "쾌청" && status === "얼음"
}