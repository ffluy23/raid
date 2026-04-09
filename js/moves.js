// moves.js
// 기술 사전
// power: 기본 위력 (0이면 랭크 전용 기술)
// type: 기술 타입
// accuracy: 명중률 (0~100, 퍼센트)
// alwaysHit: true = 회피율 무시하고 반드시 명중
// effect: 부가효과 (없으면 null)
//   - chance: 발동 확률 (0.0~1.0)
//   - status: 상태이상 ("독" / "화상" / "마비" / "얼음")
//   - volatile: 상태변화 ("혼란" / "풀죽음")
// rank: 랭크 변화 (없으면 undefined)
//   자신 대상: atk / def / spd (양수 = 랭크업)
//   상대 대상: targetAtk / targetDef / targetSpd (음수 = 랭크다운)
//   chance: 발동 확률 (없으면 100%)
//   turns: 지속 턴
//     ※ 랭크 전용 기술(power:0): turns:1 → 칼춤→칼춤→딜 구조
//     ※ 공격 부가효과 랭크: turns:2 → 다음 턴까지 유지
//   ※ power: 0 → 자신 대상이면 accuracy만 판정, 상대 대상이면 회피까지 판정
//   ※ power > 0 → 데미지 후 rank가 있으면 확률적으로 추가 적용

export const moves = {
  // ───── 랭크 전용 기술 (turns:1 — 연속 사용 시 중첩, 다른 행동 시 소멸) ─────
  "칼춤":     { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                rank: { atk: 3, turns: 2 } },
  "코튼가드": { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                rank: { def: 2, turns: 2 } },
  "고속이동": { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                rank: { spd: 3, turns: 2 } },
  "명상":     { power: 0, type: "에스퍼", accuracy: 100, alwaysHit: true, effect: null,
                rank: { atk: 1, def: 1, turns: 2 } },
  "용의춤":   { power: 0, type: "드래곤", accuracy: 100, alwaysHit: true, effect: null,
                rank: { atk: 1, spd: 1, turns: 2 } },

  // ───── 노말 ─────
  "전광석화":   { power: 30, type: "노말", accuracy: 100, alwaysHit: true,  effect: null },
  "힘껏치기":   { power: 50, type: "노말", accuracy: 75, alwaysHit: false,  effect: null },
  "베어가르기":   { power: 45, type: "노말", accuracy: 100, alwaysHit: false,  effect: null },
  "신속":       { power: 50, type: "노말", accuracy: 100, alwaysHit: true,  effect: null },
  "돌림노래":   { power: 40, type: "노말", accuracy: 100, alwaysHit: false, effect: null },
  "탐내기":     { power: 40, type: "노말", accuracy: 100, alwaysHit: false, effect: null },
  "스피드스타": { power: 35, type: "노말", accuracy: 100, alwaysHit: true,  effect: null, aoeEnemy: true },
  "할퀴기":     { power: 30, type: "노말", accuracy: 100, alwaysHit: false, effect: null },
  "몸통박치기": { power: 30, type: "노말", accuracy: 100, alwaysHit: false, effect: null },
  "하이퍼보이스":{ power: 50, type: "노말", accuracy: 100, alwaysHit: false, effect: null },
  "속이기":     { power: 30, type: "노말", accuracy: 70, alwaysHit: false,
                  effect: null, fakeOut: true },
  "성장":     { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                rank: { atk: 1, turns: 2 } },
  "야금야금":   { power: 40, type: "노말", accuracy: 100, alwaysHit: false, skipEvasion: true, effect: null },
  "박치기":     { power: 40, type: "노말", accuracy: 100, alwaysHit: false,
                  effect: { chance: 0.3, volatile: "풀죽음" } },
  "울음소리":   { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                  rank: { targetAtk: -1, turns: 2 } },
 "눈물그렁그렁":   { power: 0, type: "노말", accuracy: 100, alwaysHit: false, effect: null,
                  rank: { targetAtk: -1, turns: 2 } },
  "째려보기":   { power: 0, type: "노말", accuracy: 100, alwaysHit: false, effect: null,
                  rank: { targetDef: -1, turns: 2 }, aoeEnemy: true },
"싫은소리":   { power: 0, type: "노말", accuracy: 85, alwaysHit: false, effect: null,
                  rank: { targetDef: -2, turns: 2 } },
  "비축하기":   { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                  rank: { def: 2, turns: 2 } },
  "꼬리흔들기": { power: 0, type: "노말", accuracy: 100, alwaysHit: false, effect: null,
                  rank: { targetDef: -1, turns: 2 }, aoeEnemy: true },
  "웅크리기":   { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                  rank: { def: 1, turns: 2 } },
  "단단해지기": { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                  rank: { def: 1, turns: 2 } },
  "그림자분신": { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                  rank: { spd: 1, turns: 2 } },
  "분발":       { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                  rank: { atk: 1, turns: 2 } },
  "비밀이야기": { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                  rank: { targetAtk: -1, turns: 2 } },
  "뽐내기":     { power: 0, type: "노말", accuracy: 85, alwaysHit: false,
                  rank: { targetAtk: 2, turns: 3 }, effect: { chance: 1, volatile: "혼란" } },
  "뱀눈초리":   { power: 0, type: "노말", accuracy: 90, alwaysHit: false, targetSelf: false,
                  effect: { chance: 1, status: "마비" } },
  "누르기":     { power: 50, type: "노말", accuracy: 90, alwaysHit: false, targetSelf: false,
                  effect: { chance: 0.3, status: "마비" } },
  "소닉붐":     { power: 1, type: "노말", accuracy: 90, alwaysHit: false,
                    effect: null, fixedDamage: 40 },
  "튀어오르기": { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null, splash: true, targetSelf: true },

  // ───── 불 ─────
  "화염바퀴":     { power: 40, type: "불", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상" } },
  "니트로차지":   { power: 40, type: "불", accuracy: 100, alwaysHit: false, effect: null, rank: { spd: 1, turns: 3 } },
  "불꽃세례":     { power: 30, type: "불", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상", thawEnemy: true } },
  "도깨비불":     { power: 0,  type: "불", accuracy: 85,  alwaysHit: false, targetSelf: false, effect: { chance: 1, status: "화상" } },
  "열풍":         { power: 40, type: "불", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상" } },
  "불대문자":     { power: 40, type: "불", accuracy: 85,  alwaysHit: false, effect: null },
  "매지컬플레임": { power: 45, type: "불", accuracy: 100, alwaysHit: false, effect: null,
                    rank: { targetAtk: -1, turns: 2 } },

  // ───── 물 ─────
  "거품광선":     { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: null },
  "껍질에숨기":   { power: 0,  type: "물", accuracy: 100, alwaysHit: true, targetSelf: true, effect: null,
                    rank: { def: 1, turns: 2 } },
  "거품":         { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: null, aoeEnemy: true },
  "파도타기":     { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: null, aoe: true },
  "물대포":       { power: 30, type: "물", accuracy: 100, alwaysHit: false, effect: null },
  "아쿠아제트":       { power: 30, type: "물", accuracy: 100, alwaysHit: true, effect: null },
  "하이드로펌프": { power: 60, type: "물", accuracy: 80,  alwaysHit: false, effect: null },
  "물의파동":     { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: { chance: 0.2, volatile: "혼란" } },
  "열탕":         { power: 50, type: "물", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, status: "화상" } },
  "셸블레이드":         { power: 45,  type: "물", accuracy: 95, alwaysHit: false, effect: null,
                    rank: { chance: 0.5, targetDef: -1, turns: 2 } },

  // ───── 전기 ─────
  "번개펀치":     { power: 45, type: "전기", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "마비" } },
  "10만볼트":     { power: 50, type: "전기", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, status: "마비" } },
  "방전":         { power: 50, type: "전기", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, status: "마비" }, aoe: true },
  "번개":         { power: 60, type: "전기", accuracy: 70,  alwaysHit: false, effect: { chance: 0.3, status: "마비" } },
  "전기쇼크":     { power: 30, type: "전기", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "마비" } },
  "전기자석파":   { power: 0,  type: "전기", accuracy: 90,  alwaysHit: false, targetSelf: false,
                    effect: { chance: 1, status: "마비" } },
  "볼부비부비":   { power: 30,  type: "전기", accuracy: 100,  alwaysHit: false, targetSelf: false,
                    effect: { chance: 1, status: "마비" } },
  "전자포":   { power: 60,  type: "전기", accuracy: 50,  alwaysHit: false, targetSelf: false,
                    effect: { chance: 1, status: "마비" } },
  "충전":         { power: 0,  type: "전기", accuracy: 100, alwaysHit: true, targetSelf: true, effect: null,
                    rank: { atk: 2, def: 1, turns: 2 } },

  // ───── 풀 ─────
  "에너지볼":   { power: 40, type: "풀", accuracy: 100, alwaysHit: false, effect: null,
                  rank: { chance: 0.1, targetDef: -1, turns: 2 } },
  "솔라빔":     { power: 40, type: "풀", accuracy: 100, alwaysHit: false, effect: null },
  "나뭇잎":     { power: 30, type: "풀", accuracy: 100, alwaysHit: false, effect: null },
  "잎날가르기":     { power: 40, type: "풀", accuracy: 95, alwaysHit: false, effect: null, highCrit: true },
  "씨폭탄":     { power: 40, type: "풀", accuracy: 100, alwaysHit: false, effect: null },
  "성장":       { power: 0,  type: "풀", accuracy: 100, alwaysHit: true, targetSelf: true, effect: null,
                  rank: { atk: 1, turns: 2 } },
  "흡수":       { power: 30, type: "풀", accuracy: 100, alwaysHit: false, effect: { drain: 0.15 } },
  "메가드레인": { power: 30, type: "풀", accuracy: 100, alwaysHit: false, effect: { drain: 0.15 } },
  "기가드레인": { power: 45, type: "풀", accuracy: 100, alwaysHit: false, effect: { drain: 0.15 } },

  // ───── 얼음 ─────
  "눈보라":         { power: 40, type: "얼음", accuracy: 70,  alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },
  "얼음뭉치":       { power: 35, type: "얼음", accuracy: 100, alwaysHit: true,  effect: null },
  "냉동빔":         { power: 50, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },
  "얼어붙은바람":   { power: 40, type: "얼음", accuracy: 95,  alwaysHit: false, targetSelf: false, effect: null,
                      rank: { targetSpd: -1, turn: 2 }, aoeEnemy: true },
  "아이스펀치":     { power: 40, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },
  "얼음엄니":       { power: 40, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },
  "눈싸라기":       { power: 30, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "얼음" }, aoeEnemy: true },
  "흑안개":     { power: 0,  type: "얼음", accuracy: 100, alwaysHit: true, effect: null, haze: true, targetSelf: true },
  // ───── 격투 ─────
  "인파이트":           { power: 60, type: "격투", accuracy: 100, alwaysHit: false, targetSelf: true, effect: null,
                          rank: { def: -1, turns: 2 } },
  "파동탄":             { power: 40, type: "격투", accuracy: 100, alwaysHit: true,  effect: null },
  "깨트리기":           { power: 45, type: "격투", accuracy: 100, alwaysHit: false, effect: null, breakBarrier: true },
  "발뒤꿈치떨어뜨리기": { power: 40, type: "격투", accuracy: 100, alwaysHit: false, effect: null },

  // ───── 독 ─────
  "용해액":   { power: 30, type: "독", accuracy: 100, alwaysHit: false, effect: null,
                rank: { chance: 0.1, def: -1, turns: 2 }, aoeEnemy: true },
  "독침":     { power: 30, type: "독", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, status: "독" } },
  "독찌르기": { power: 50, type: "독", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, status: "독" } },
  "독가루":   { power: 0,  type: "독", accuracy: 75,  alwaysHit: false, targetSelf: false,
                effect: { chance: 1, status: "독" }, poisonPowder: true },

  // ───── 땅 ─────
  "지진":       { power: 50, type: "땅", accuracy: 100, alwaysHit: false, effect: null },
  "땅고르기":   { power: 40, type: "땅", accuracy: 100, alwaysHit: false, effect: null,
                  rank: { targetSpd: -1, turns: 3 }, aoe: true },
  "모래뿌리기": { power: 0,  type: "땅", accuracy: 100, alwaysHit: false, targetSelf: false, effect: null,
                  rank: { targetSpd: -1, turns: 3 } },
  "진흙뿌리기": { power: 30, type: "땅", accuracy: 100, alwaysHit: false, targetSelf: false, effect: null,
                  rank: { targetSpd: -1, turns: 3 } },

  // ───── 바위 ─────
  "스톤에지":   { power: 40, type: "바위", accuracy: 80,  alwaysHit: false, effect: null },
  "돌떨구기":   { power: 40, type: "바위", accuracy: 90,  alwaysHit: false, effect: null },
  "바위깨기":   { power: 30, type: "바위", accuracy: 80,  alwaysHit: false, effect: null,
                  rank: { targetDef: -1, turns: 3 } },
  "파워젬":     { power: 50, type: "바위", accuracy: 80,  alwaysHit: false, effect: null },
  "록블라스트": { power: 40, type: "바위", accuracy: 90,  alwaysHit: false, effect: null },
  "원시의힘":   { power: 40, type: "바위", accuracy: 100, alwaysHit: false, effect: null,
                  rank: { chance: 0.1, atk: 1, def: 1, spd: 1, turns: 3 } },

  // ───── 비행 ─────
  "에어슬래시": { power: 40, type: "비행", accuracy: 95,  alwaysHit: false, effect: { chance: 0.3, volatile: "풀죽음" } },
  "애크러뱃":   { power: 45, type: "비행", accuracy: 100, alwaysHit: false, effect: null },
  "열풍비행":   { power: 40, type: "비행", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상" } },
  "쪼기":       { power: 40, type: "비행", accuracy: 100, alwaysHit: false, effect: null },
  "날개치기":   { power: 40, type: "비행", accuracy: 100, alwaysHit: false, effect: null },
  "회전부리":   { power: 50, type: "비행", accuracy: 100, alwaysHit: false, effect: null },
  "제비반환":   { power: 45, type: "비행", accuracy: 100, alwaysHit: true, effect: null },
  // 공중날기: flyState로 2턴 처리
  "공중날기":   { power: 50, type: "비행", accuracy: 95, alwaysHit: false, effect: null, fly: true },

  // ───── 에스퍼 ─────
  "사이코키네시스": { power: 50, type: "에스퍼", accuracy: 100, alwaysHit: false, effect: null,
                      rank: { chance: 0.1, targetDef: -1, turns: 2 } },
  "망각술": { power: 0, type: "에스퍼", accuracy: 100, alwaysHit: true, effect: null,
                      rank: { chance: 1, def: 2, turns: 2 } },
  "사이코쇼크":     { power: 50, type: "에스퍼", accuracy: 100, alwaysHit: false, effect: null },
  "염동력":         { power: 40, type: "에스퍼", accuracy: 100, alwaysHit: false,
                      effect: { chance: 0.1, volatile: "혼란" } },
  "미래예지":       { power: 40, type: "에스퍼", accuracy: 100, alwaysHit: false, effect: null },
  "사념의박치기":   { power: 50, type: "에스퍼", accuracy: 100, alwaysHit: false,
                      effect: { chance: 0.2, volatile: "풀죽음" } },
  // 빛의 장막: lightScreen 플래그
  "빛의장막":       { power: 0, type: "에스퍼", accuracy: 100, alwaysHit: true, effect: null,
                      lightScreen: true, targetSelf: true },
  // 어시스트파워: assistPower 플래그
  "어시스트파워":   { power: 30, type: "에스퍼", accuracy: 100, alwaysHit: false, effect: null, assistPower: true },

  // ───── 벌레 ─────
  "달려들기":   { power: 40, type: "벌레", accuracy: 100, alwaysHit: false,
                  rank: { targetSpd: -1, turns: 3 } },
  "실뿜기":     { power: 0,  type: "벌레", accuracy: 95,  alwaysHit: false,
                  rank: { targetSpd: -2, turns: 3 }, aoeEnemy: true },
  "벌레먹음":   { power: 40, type: "벌레", accuracy: 100, alwaysHit: false, effect: null },
  "흡혈":       { power: 50, type: "벌레", accuracy: 100, alwaysHit: false, effect: { drain: 0.15 } },
  // 고속스핀: rapidSpin 플래그
  "고속스핀":   { power: 40, type: "노말", accuracy: 100, alwaysHit: false, effect: null,
                  rapidSpin: true, rank: { spd: 1, turns: 3 } },

  // ───── 고스트 ─────
  "섀도볼":     { power: 50, type: "고스트", accuracy: 100, alwaysHit: false, effect: null,
                  rank: { chance: 0.2, targetDef: -1, turns: 3 } },
  "섀도크루":   { power: 55, type: "고스트", accuracy: 100, alwaysHit: false, effect: null, highCrit: true },
  "나이트헤드": { power: 40, type: "고스트", accuracy: 100, alwaysHit: true,  effect: null },
  "섀도스니크": { power: 40, type: "고스트", accuracy: 100, alwaysHit: false, effect: null },
  "이상한빛":   { power: 0,  type: "고스트", accuracy: 100, alwaysHit: false,
                  effect: { chance: 1, volatile: "혼란" } },
  "핥기":       { power: 30, type: "고스트", accuracy: 100, alwaysHit: false,
                  effect: { chance: 0.3, status: "마비" } },
  "야습":       { power: 45, type: "고스트", accuracy: 100, alwaysHit: true,  effect: null },
  "기습":       { power: 45, type: "고스트", accuracy: 100, alwaysHit: true,  effect: null },
  "놀래키기":   { power: 30, type: "고스트", accuracy: 100, alwaysHit: false,
                  effect: { chance: 0.3, volatile: "풀죽음" } },
  "괴상한바람":   { power: 40, type: "고스트", accuracy: 100, alwaysHit: false, effect: null, rank: { chance: 0.1, spd: 1, def: 1, atk: 1, turns: 3 } },

  // ───── 드래곤 ─────
  "드래곤크루":   { power: 50, type: "드래곤", accuracy: 100, alwaysHit: false, effect: null },
  "드래곤다이브": { power: 50, type: "드래곤", accuracy: 75,  alwaysHit: false,
                    effect: { chance: 0.2, volatile: "풀죽음" } },
  "용의숨결": { power: 40, type: "드래곤", accuracy: 75,  alwaysHit: false,
                    effect: { chance: 0.3, status: "마비" } },
  // 용의분노: fixedDamage 40
  "용의분노":     { power: 1, type: "드래곤", accuracy: 100, alwaysHit: false,
                    effect: null, fixedDamage: 40 },
  // 자이로볼: gyroBall 플래그
  "자이로볼":     { power: 30, type: "강철", accuracy: 100, alwaysHit: false, effect: null, gyroBall: true },
  "회오리":     { power: 30, type: "드래곤", accuracy: 100, alwaysHit: false,
                  effect: { chance: 0.2, volatile: "풀죽음" }, twister: true, aoeEnemy: true },

  // ───── 악 ─────
  "악의파동":   { power: 50, type: "악", accuracy: 100, alwaysHit: false,
                  effect: { chance: 0.2, volatile: "풀죽음" } },
  "속여때리기": { power: 40, type: "악", accuracy: 100, alwaysHit: true,  effect: null },
  "물기":       { power: 40, type: "악", accuracy: 100, alwaysHit: false,
                  effect: { chance: 0.3, volatile: "풀죽음" } },
  "암타":       { power: 40, type: "악", accuracy: 100, alwaysHit: false, effect: null },
  "바크아웃":   { power: 0,  type: "악", accuracy: 95,  alwaysHit: false, effect: null,
                  rank: { targetAtk: -1, turns: 3 }, aoeEnemy: true },
  "거짓울음":   { power: 0, type: "악", accuracy: 100, alwaysHit: false, effect: null,
                  rank: { targetDef: -2, turns: 2 } },
  "승부굳히기": { power: 40, type: "악", accuracy: 100, alwaysHit: false, effect: null, finisher: true },

  // ───── 강철 ─────
  "아이언테일": { power: 50, type: "강철", accuracy: 75,  alwaysHit: false, effect: null,
                  rank: { chance: 0.3, targetDef: -1, turns: 3 } },
  "아이언헤드": { power: 50, type: "강철", accuracy: 75,  alwaysHit: false,
                  effect: { chance: 0.3, volatile: "풀죽음" } },
  "메탈크로우": { power: 40, type: "강철", accuracy: 95,  alwaysHit: false, effect: null,
                  rank: { chance: 0.1, atk: 1, turns: 3 } },
  "코멧펀치": { power: 50, type: "강철", accuracy: 90,  alwaysHit: false, effect: null,
                  rank: { chance: 0.2, atk: 1, turns: 3 } },
  "러스터캐논": { power: 50, type: "강철", accuracy: 100,  alwaysHit: false, effect: null,
                  rank: { chance: 0.1, targetAtk: -1, turns: 2 } },
  "불릿펀치":   { power: 40, type: "강철", accuracy: 100, alwaysHit: false, effect: null },
  "플래시캐논": { power: 40, type: "강철", accuracy: 100, alwaysHit: true,  effect: null },
  "강철날개":   { power: 50, type: "강철", accuracy: 100, alwaysHit: false,
                  effect: { chance: 0.1, def: 1, turns: 3 } },
  "금속음":   { power: 0, type: "강철", accuracy: 85, alwaysHit: false, effect: null,
                  rank: { targetDef: -2, turns: 2 } },
  "철벽":   { power: 0, type: "강철", accuracy: 85, alwaysHit: true, effect: null,
                  rank: { def: 2, turns: 2 } },


  // ───── 페어리 ─────
  "문포스":       { power: 40, type: "페어리", accuracy: 100, alwaysHit: false, effect: null },
  "요정의바람":   { power: 30, type: "페어리", accuracy: 100, alwaysHit: false, effect: null },
  "치근거리기":   { power: 50, type: "페어리", accuracy: 90,  alwaysHit: false, effect: null,
                    rank: { chance: 0.1, targetAtk: -1, turns: 2 } },
  "차밍보이스":   { power: 35, type: "페어리", accuracy: 100, alwaysHit: true,  effect: null, aoeEnemy: true },
  "매지컬샤인":   { power: 50, type: "페어리", accuracy: 100, alwaysHit: false, effect: null, aoeEnemy: true },
  "드레인키스":   { power: 40, type: "페어리", accuracy: 100, alwaysHit: false, effect: { drain: 0.2 } },
  "애교부리기":   { power: 0,  type: "페어리", accuracy: 100, alwaysHit: false, targetSelf: false, effect: null,
                    rank: { targetAtk: -1, turns: 2 } },
  "초롱초롱눈동자":   { power: 0,  type: "페어리", accuracy: 100, alwaysHit: true, targetSelf: false, effect: null,
                    rank: { targetAtk: -1, turns: 2 } },


  // ───── 날씨 ─────
  "맑게개다": { power: 0, type: "불",   accuracy: 100, alwaysHit: false, effect: { chance: 1.0, weather: "쾌청" } },
  "비바라기": { power: 0, type: "물",   accuracy: 100, alwaysHit: false, effect: { chance: 1.0, weather: "비" } },
  "모래바람": { power: 0, type: "바위", accuracy: 100, alwaysHit: false, effect: { chance: 1.0, weather: "모래바람" } },
  "싸라기눈": { power: 0, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 1.0, weather: "싸라기눈" } },

  // ───── 특수 기술 ─────
  "무릎차기":   { power: 70, type: "격투", accuracy: 90,  alwaysHit: false, effect: null, jumpKick: true },
  "방어":       { power: 0,  type: "노말", accuracy: 100, alwaysHit: true,  effect: null, defend: true, targetSelf: true },
   "판별":       { power: 0,  type: "격투", accuracy: 100, alwaysHit: true,  effect: null, defend: true, targetSelf: true },
  "울부짖기":   { power: 0,  type: "노말", accuracy: 100, alwaysHit: false, effect: null, roar: true, targetSelf: false },
  "원수갚기":   { power: 40, type: "노말", accuracy: 100, alwaysHit: false, effect: null, revenge: true },
  "뒀다쓰기":   { power: 70, type: "노말", accuracy: 100, alwaysHit: false, effect: null, lastResort: true },
  "신비의부적": { power: 0,  type: "노말", accuracy: 100, alwaysHit: true,  effect: null, amulet: true, targetSelf: true },
  "클리어스모그":{ power: 40, type: "독",  accuracy: 100, alwaysHit: true,  effect: null, clearSmog: true },
  "구르기":     { power: 30, type: "바위", accuracy: 90,  alwaysHit: false, effect: null, rollout: true },
  "태만함":     { power: 0,  type: "노말", accuracy: 100, alwaysHit: true,  effect: { heal: 0.22 }, targetSelf: true },
  "HP회복":     { power: 0,  type: "노말", accuracy: 100, alwaysHit: true,  effect: { heal: 0.22 }, targetSelf: true },
  "생명의물방울":{ power: 0, type: "물", accuracy: 100, alwaysHit: true, effect: { heal: 0.22 }, targetSelf: true, waterHeal: true },
  "희망사항":   { power: 0,  type: "노말", accuracy: 100, alwaysHit: true,  effect: null, wish: true, targetSelf: true },

  "속임수":         { power: 50, type: "악",    accuracy: 100, alwaysHit: false, effect: null, trickster: true },
  "날개쉬기":       { power: 0,  type: "비행",  accuracy: 100, alwaysHit: true,
                      effect: { removeFlying: true }, targetSelf: true },
  "이판사판태클":   { power: 70, type: "노말",  accuracy: 100, alwaysHit: false, effect: { recoil: 0.33 } },
  "돌진":           { power: 50, type: "노말",  accuracy: 85,  alwaysHit: false, effect: { recoil: 0.25 } },
  "보복":           { power: 50, type: "악",    accuracy: 100, alwaysHit: false, effect: null, comeback: true },
  "마구찌르기":     { power: 1,  type: "노말",  accuracy: 85,  alwaysHit: false, effect: null,
                      multiHit: { min: 2, max: 5, fixedDamage: 10 } },
  "바늘미사일":     { power: 1,  type: "벌레",  accuracy: 95,  alwaysHit: false, effect: null,
                      multiHit: { min: 2, max: 5, fixedDamage: 6 } },
  "사슬묶기":       { power: 0,  type: "노말",  accuracy: 90,  alwaysHit: false, effect: null,
                      chainBind: true, targetSelf: false },
  "드래곤테일":     { power: 40, type: "드래곤", accuracy: 90,  alwaysHit: false, effect: null, dragonTail: true },
  "병상첨병":       { power: 40, type: "고스트", accuracy: 100, alwaysHit: false, effect: null, sickPower: true },
  "기사회생":       { power: 40, type: "격투",  accuracy: 100, alwaysHit: false, effect: null, reversal: true },
  "바둥바둥":       { power: 40, type: "노말",  accuracy: 100, alwaysHit: false, effect: null, reversal: true },
  "카운터":         { power: 1,  type: "격투",  accuracy: 100, alwaysHit: false, effect: null, counter: true },
  "버티기":         { power: 0,  type: "노말",  accuracy: 100, alwaysHit: true,  effect: null,
                      endure: true, targetSelf: true },
  "객기":           { power: 40, type: "노말",  accuracy: 100, alwaysHit: false, effect: null, guts: true },
  "씨뿌리기":       { power: 0,  type: "풀",   accuracy: 90,  alwaysHit: false, effect: null,
                      leechSeed: true, targetSelf: false },
  "치유파동":       { power: 0,  type: "에스퍼", accuracy: 100, alwaysHit: true,  effect: null,
                      healPulse: true, targetSelf: false },
  "참기":           { power: 0,  type: "노말",  accuracy: 100, alwaysHit: true,  effect: null,
                      bide: true, targetSelf: true },
  "구멍파기":   { power: 50, type: "땅",   accuracy: 100, alwaysHit: false, effect: null, dig: true },

}