// moves.js
// 기술 사전
// power: 기본 위력 (0이면 랭크 전용 기술)
// type: 기술 타입
// accuracy: 명중률 (0~100, 퍼센트)
// alwaysHit: true = 회피율 무시하고 반드시 명중
// aoe: true = 더블배틀 전용 전체공격 (자신 제외 필드 위 모든 포켓몬에게 데미지)
//            → 클라이언트가 자동으로 targetSlots = [자신 제외 전체]로 설정
//            → 다중 타겟이므로 isAoe=true → 데미지 ×0.75 감쇄 (useMove 서버 기존 로직)
// effect: 부가효과 (없으면 null)
//   - chance: 발동 확률 (0.0~1.0)
//   - status: 상태이상 ("독" / "화상" / "마비" / "얼음")
//   - volatile: 상태변화 ("혼란" / "풀죽음")
// rank: 랭크 변화 (없으면 undefined)
//   자신 대상: atk / def / spd (양수 = 랭크업)
//   상대 대상: targetAtk / targetDef / targetSpd (음수 = 랭크다운)
//   chance: 발동 확률 (없으면 100%)
//   turns: 지속 턴

export const moves = {
  // ───── 랭크 전용 기술 (turns:1 — 연속 사용 시 중첩, 다른 행동 시 소멸) ─────
  "칼춤":     { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                rank: { atk: 3, turns: 1 } },
  "코튼가드": { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                rank: { def: 2, turns: 1 } },
  "고속이동": { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                rank: { spd: 3, turns: 1 } },
  "명상":     { power: 0, type: "에스퍼", accuracy: 100, alwaysHit: true, effect: null,
                rank: { atk: 1, def: 1, turns: 1 } },

  // ───── 노말 ─────
  "전광석화":   { power: 30, type: "노말", accuracy: 100, alwaysHit: true,  effect: null },
  "돌림노래":   { power: 40, type: "노말", accuracy: 100, alwaysHit: false,  effect: null },
  "탐내기":   { power: 40, type: "노말", accuracy: 100, alwaysHit: false,  effect: null },
  "스피드스타":   { power: 35, type: "노말", accuracy: 100, alwaysHit: true, aoeEnemy: true, effect: null },
  "할퀴기":   { power: 30, type: "노말", accuracy: 100, alwaysHit: false,  effect: null },
  "몸통박치기": { power: 30, type: "노말", accuracy: 100, alwaysHit: false, effect: null },
  "하이퍼보이스": { power: 50, type: "노말", accuracy: 100, alwaysHit: false, aoeEnemy: true, effect: null },
  "속이기":     { power: 30, type: "노말", accuracy: 50, alwaysHit: false, skipEvasion: true,
                  effect: { chance: 1, volatile: "풀죽음" } },
  "야금야금":     { power: 40, type: "노말", accuracy: 100, alwaysHit: false, skipEvasion: true, effect: null },
  "박치기":     { power: 40, type: "노말", accuracy: 100, alwaysHit: false,
                  effect: { chance: 0.3, volatile: "풀죽음" } },
  "울음소리":   { power: 0, type: "노말", accuracy: 100, alwaysHit: false, aoeEnemy: true,
                    effect: null, rank: { targetAtk: -1, turns: 1 } },
  "째려보기":   { power: 0, type: "노말", accuracy: 100, alwaysHit: false, aoeEnemy: true, effect: null,
                  rank: { targetDef: -1, turns: 1 } },
  "꼬리흔들기":   { power: 0, type: "노말", accuracy: 100, alwaysHit: false, aoeEnemy: true, effect: null,
                  rank: { targetDef: -1, turns: 1 } },
  "웅크리기":   { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                  rank: { def: 1, turns: 1 } },
  "단단해지기":   { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                  rank: { def: 1, turns: 1 } },
  "그림자분신":   { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                  rank: { spd: 1, turns: 1 } },
  "분발":   { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                  rank: { atk: 1, turns: 1 } },
  "비밀이야기":   { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                  rank: { targetAtk: -1, turns: 1 } },
  "뽐내기":     { power: 0, type: "노말", accuracy: 85, alwaysHit: false,
                  rank: { targetAtk: 2, turns: 2 }, effect: { chance: 1, volatile: "혼란" } },
  "뱀눈초리": { power: 0, type: "노말", accuracy: 90, alwaysHit: false, targetSelf: false, effect: { chance: 1, status: "마비" } },
  "누르기": { power: 50, type: "노말", accuracy: 90, alwaysHit: false, targetSelf: false, effect: { chance: 0.3, status: "마비" } },

  // ───── 불 ─────
  "화염바퀴":     { power: 40, type: "불", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상" } },
  "니트로차지":     { power: 40, type: "불", accuracy: 100, alwaysHit: false, effect: null, rank: { spd: 1, turns: 2 } },
  "불꽃세례":     { power: 30, type: "불", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상" } },
  "도깨비불":     { power: 0, type: "불", accuracy: 85, alwaysHit: false, targetSelf: false, effect: { chance: 1, status: "화상" } },
  "열풍":         { power: 40, type: "불", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상" } },
  "불대문자":     { power: 40, type: "불", accuracy: 85,  alwaysHit: false, effect: null },
  "매지컬플레임": { power: 45, type: "불", accuracy: 100, alwaysHit: false, effect: null,
                    rank: { targetAtk: -1, turns: 2 } },

  // ───── 물 ─────
  "거품광선":     { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: null },
  "껍질에숨기":     { power: 0, type: "물", accuracy: 100, alwaysHit: true, targetSelf: true , effect: null, rank: { def: 1, turns: 1 } },
  "거품":         { power: 40, type: "물", accuracy: 100, alwaysHit: false, aoeEnemy: true, effect: null },
  "파도타기":     { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: null },
  "물대포":       { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: null },
  "하이드로펌프": { power: 40, type: "물", accuracy: 80,  alwaysHit: false, effect: null },
  "아쿠아제트":   { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: null },

  // ───── 전기 ─────
  "번개펀치":   { power: 40, type: "전기", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "마비" } },
  "10만볼트":   { power: 50, type: "전기", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, status: "마비" } },
  "방전":       { power: 40, type: "전기", accuracy: 100, alwaysHit: false, aoe: true,  effect: { chance: 0.3, status: "마비" } },
  "번개":       { power: 60, type: "전기", accuracy: 70,  alwaysHit: false, effect: { chance: 0.3, status: "마비" } },
  "전기쇼크":   { power: 40, type: "전기", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "마비" } },
  "전기자석파": { power: 0, type: "전기", accuracy: 90, alwaysHit: false, targetSelf: false, effect: { chance: 1, status: "마비" } },
  "충전": { power: 0, type: "전기", accuracy: 100, alwaysHit: true, targetSelf: true, effect: null, rank: { atk: 2, def: 1, turns: 1 } },

  // ───── 풀 ─────
  "에너지볼":   { power: 40, type: "풀", accuracy: 100, alwaysHit: false, effect: null, rank: { chance: 0.1, targetDef: -1, turns: 1 } },
  "솔라빔":     { power: 40, type: "풀", accuracy: 100, alwaysHit: false, effect: null },
  "나뭇잎": { power: 30, type: "풀", accuracy: 100, alwaysHit: false, effect: null },
  "씨폭탄":     { power: 40, type: "풀", accuracy: 100, alwaysHit: false, effect: null },
  "성장":           { power: 0, type: "풀", accuracy: 100, alwaysHit: true, targetSelf: true, effect: null, rank: { atk: 1, turns: 1 }  },
  "흡수": { power: 40, type: "풀", accuracy: 100, alwaysHit: false, effect: { drain: 0.12 } },

  // ───── 얼음 ─────
  "눈보라":     { power: 40, type: "얼음", accuracy: 70,  alwaysHit: false, aoe: true,  effect: { chance: 0.1, status: "얼음" } },
  "얼음뭉치":     { power: 40, type: "얼음", accuracy: 100,  alwaysHit: true, effect: null },
  "냉동빔":     { power: 40, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },
  "얼어붙은바람":     { power: 40, type: "얼음", accuracy: 95, alwaysHit: false, targetSelf: false, aoeEnemy: true, effect: null, rank: { targetSpd: -1, turns: 1 } },
  "아이스펀치": { power: 40, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },
  "얼음엄니":   { power: 40, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },
  "아이스해머": { power: 40, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },

  // ───── 격투 ─────
  "인파이트":           { power: 60, type: "격투", accuracy: 100, alwaysHit: false, targetSelf: true, effect: null, rank: { def: -1, turns: 1 }  },
  "파동탄":             { power: 40, type: "격투", accuracy: 100, alwaysHit: true,  effect: null },
  "깨트리기":             { power: 45, type: "격투", accuracy: 100, alwaysHit: false,  effect: null },
  "발뒤꿈치떨어뜨리기": { power: 40, type: "격투", accuracy: 100, alwaysHit: false, effect: null },

  // ───── 독 ─────
  "용해액": { power: 30, type: "독", accuracy: 100, alwaysHit: false, effect: null, aoeEnemy: true, rank: { chance: 0.1, def: -1, turns: 1 } },
  "헤이즈": { power: 40, type: "독", accuracy: 100, alwaysHit: false, effect: { chance: 0.2, status: "독" } },

  // ───── 땅 ─────
  "지진":     { power: 40, type: "땅", accuracy: 100, alwaysHit: false, aoe: true,  effect: null },
  "땅가르기": { power: 40, type: "땅", accuracy: 100, alwaysHit: false, effect: null },
  "모래뿌리기":     { power: 0, type: "땅", accuracy: 100, alwaysHit: false, targetSelf: false, effect: null, rank: { targetSpd: -1, turns: 1 } },
  "진흙뿌리기":     { power: 20, type: "땅", accuracy: 100, alwaysHit: false, targetSelf: false, effect: null, rank: { targetSpd: -1, turns: 1 } },

  // ───── 바위 ─────
  "스톤에지":   { power: 40, type: "바위", accuracy: 80,  alwaysHit: false, effect: null },
  "돌떨구기":   { power: 40, type: "바위", accuracy: 90,  alwaysHit: false, effect: null },
  "바위깨기":   { power: 30, type: "바위", accuracy: 80,  alwaysHit: false, effect: null,
                  rank: { targetDef: -1, turns: 2 } },
  "파워젬":     { power: 50, type: "바위", accuracy: 80,  alwaysHit: false, effect: null },
  "록블라스트": { power: 40, type: "바위", accuracy: 90,  alwaysHit: false, effect: null },
  "원시의힘":   { power: 40, type: "바위", accuracy: 100, alwaysHit: false, effect: null,
                  rank: { chance: 0.1, atk: 1, def: 1, spd: 1, turns: 2 } },

  // ───── 비행 ─────
  "에어슬래시": { power: 40, type: "비행", accuracy: 95,  alwaysHit: false, effect: { chance: 0.3, volatile: "풀죽음" } },
  "열풍비행":   { power: 40, type: "비행", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상" } },
  "쪼기":       { power: 40, type: "비행", accuracy: 100, alwaysHit: false, effect: null },
  "날개치기":   { power: 40, type: "비행", accuracy: 100, alwaysHit: false, effect: null },
  "애크러뱃": { power: 45, type: "비행", accuracy: 100,  alwaysHit: false, effect: null },

  // ───── 에스퍼 ─────
  "사이코키네시스": { power: 50, type: "에스퍼", accuracy: 100, alwaysHit: false, effect: null, rank: { chance: 0.1, targetDef: -1, turns: 1 } },
  "사이코쇼크": { power: 50, type: "에스퍼", accuracy: 100, alwaysHit: false, effect: null },
  "염동력": { power: 40, type: "에스퍼", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, volatile: "혼란" } },
  "미래예지":       { power: 40, type: "에스퍼", accuracy: 100, alwaysHit: false, effect: null },
  "사념의박치기": { power: 50, type: "에스퍼", accuracy: 100, alwaysHit: false, effect: { chance: 0.2, volatile: "풀죽음" } },

  // ───── 벌레 ─────
  "버그버즈":   { power: 40, type: "벌레", accuracy: 100, alwaysHit: false, effect: null },
  "시저크로스": { power: 40, type: "벌레", accuracy: 100, alwaysHit: false, effect: null },

  // ───── 고스트 ─────
  "섀도볼":     { power: 50, type: "고스트", accuracy: 100, alwaysHit: false, effect: null,
                  rank: { chance: 0.2, targetDef: -1, turns: 2 } },
  "섀도크루":     { power: 55, type: "고스트", accuracy: 100, alwaysHit: false, effect: null },
  "나이트헤드": { power: 40, type: "고스트", accuracy: 100, alwaysHit: true,  effect: null },
  "섀도스니크": { power: 40, type: "고스트", accuracy: 100, alwaysHit: false, effect: null },
  "이상한빛":   { power: 0, type: "고스트", accuracy: 100, alwaysHit: false, effect: { chance: 1, volatile: "혼란" } },
  "놀래키기":   { power: 30, type: "고스트", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, volatile: "혼란" } },
  "핥기":   { power: 30, type: "고스트", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, status: "마비" } },
  "야습":   { power: 45, type: "고스트", accuracy: 100, alwaysHit: true,  effect: null },

  // ───── 드래곤 ─────
  "드래곤크루": { power: 40, type: "드래곤", accuracy: 100, alwaysHit: false, effect: null },
  "역린":       { power: 40, type: "드래곤", accuracy: 100, alwaysHit: false, effect: { chance: 0.2, volatile: "혼란" } },

  // ───── 악 ─────
  "악의파동": { power: 50, type: "악", accuracy: 100, alwaysHit: false, effect: { chance: 0.2, volatile: "풀죽음" } },
  "속여때리기": { power: 40, type: "악", accuracy: 100, alwaysHit: true, effect: null },
  "물기": { power: 40, type: "악", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, volatile: "풀죽음" } },
  "암타":     { power: 40, type: "악", accuracy: 100, alwaysHit: false, effect: null },
  "바크아웃": { power: 0, type: "악", accuracy: 95, alwaysHit: false, aoeEnemy: true,
                    effect: null, rank: { targetAtk: -1, turns: 2 } },

  // ───── 강철 ─────
  "아이언테일": { power: 50, type: "강철", accuracy: 75,  alwaysHit: false, effect: null,
                  rank: { chance: 0.3, targetDef: -1, turns: 2 } },
  "메탈크로우": { power: 40, type: "강철", accuracy: 95,  alwaysHit: false, effect: null,
                  rank: { chance: 0.1, atk: 1, turns: 2 } },
  "불릿펀치":   { power: 40, type: "강철", accuracy: 100, alwaysHit: false, effect: null },
  "플래시캐논": { power: 40, type: "강철", accuracy: 100, alwaysHit: true,  effect: null },

  // ───── 페어리 ─────
  "문포스":     { power: 40, type: "페어리", accuracy: 100, alwaysHit: false, effect: null },
  "요정의바람":     { power: 30, type: "페어리", accuracy: 100, alwaysHit: false, effect: null },
  "치근거리기":     { power: 50, type: "페어리", accuracy: 90, alwaysHit: false, effect: null, rank: { chance: 0.1, targetAtk: -1, turns: 1 } },
  "차밍보이스": { power: 35, type: "페어리", accuracy: 100, alwaysHit: true, aoeEnemy: true, effect: null },
  "매지컬샤인": { power: 50, type: "페어리", accuracy: 100, alwaysHit: false, aoeEnemy: true,  effect: null },
  "드레인키스": { power: 40, type: "페어리", accuracy: 100, alwaysHit: false, effect: { drain: 0.2 } },
  "애교부리기": { power: 0, type: "페어리", accuracy: 100, alwaysHit: false, targetSelf: false, effect: null, rank: { targetAtk: -1, turns: 1 } },

  // ───── 날씨 ─────
  "맑게개다": { power: 0, type: "불",   accuracy: 100, alwaysHit: false, effect: { chance: 1.0, weather: "쾌청" } },
  "비바라기": { power: 0, type: "물",   accuracy: 100, alwaysHit: false, effect: { chance: 1.0, weather: "비" } },
  "모래바람": { power: 0, type: "바위", accuracy: 100, alwaysHit: false, effect: { chance: 1.0, weather: "모래바람" } },
  "싸라기눈": { power: 0, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 1.0, weather: "싸라기눈" } },

  // ───── 특수 기술 ─────
  "무릎차기":   { power: 70, type: "격투", accuracy: 90,  alwaysHit: false, effect: null, jumpKick: true },
  "방어":       { power: 0,  type: "노말", accuracy: 100, alwaysHit: true,  effect: null, defend: true, targetSelf: true },
  "울부짖기":   { power: 0,  type: "노말", accuracy: 100, alwaysHit: false, effect: null, roar: true, targetSelf: false },
  "원수갚기":   { power: 40, type: "노말", accuracy: 100, alwaysHit: false, effect: null, revenge: true },
  "뒀다쓰기":   { power: 70, type: "노말", accuracy: 100, alwaysHit: false, effect: null, lastResort: true },
  "신비의부적": { power: 0,  type: "노말", accuracy: 100, alwaysHit: true,  effect: null, amulet: true, targetSelf: true },
  "클리어스모그": { power: 40, type: "독", accuracy: 100, alwaysHit: true,  effect: null, clearSmog: true },
  "구르기":     { power: 30, type: "바위", accuracy: 90, alwaysHit: false, effect: null, rollout: true },
  "태만함":     { power: 0,  type: "노말", accuracy: 100, alwaysHit: true,  effect: { heal: 0.12 }, targetSelf: true },
  "HP회복":     { power: 0,  type: "노말", accuracy: 100, alwaysHit: true,  effect: { heal: 0.12 }, targetSelf: true },
  "희망사항":   { power: 0,  type: "노말", accuracy: 100, alwaysHit: true,  effect: null, wish: true, targetSelf: true },

  // ───── 특수 기술 추가분 ─────
  "속임수":       { power: 50, type: "악", accuracy: 100, alwaysHit: false, effect: null, trickster: true },
  "날개쉬기": { power: 0, type: "비행", accuracy: 100, alwaysHit: true,
              effect: { removeFlying: true, heal: 0.12 }, targetSelf: true },
  "이판사판태클": { power: 70, type: "노말", accuracy: 100, alwaysHit: false, effect: { recoil: 0.33 } },
  "보복":         { power: 50, type: "악", accuracy: 100, alwaysHit: false, effect: null, comeback: true },
  "마구찌르기": { power: 1, type: "노말", accuracy: 100, alwaysHit: false, effect: null, multiHit: { min: 2, max: 5, fixedDamage: 10 } },
  "사슬묶기":     { power: 0, type: "노말", accuracy: 90, alwaysHit: false, effect: null, chainBind: true, targetSelf: false },
  "드래곤테일":   { power: 40, type: "드래곤", accuracy: 90, alwaysHit: false, effect: null, dragonTail: true },
  "병상첨병": { power: 40, type: "고스트", accuracy: 100, alwaysHit: false, effect: null, sickPower: true },
  "기사회생": { power: 40, type: "격투", accuracy: 100, alwaysHit: false, effect: null, reversal: true },
  "바둥바둥": { power: 40, type: "노말", accuracy: 100, alwaysHit: false, effect: null, reversal: true },
  "카운터":   { power: 1,  type: "격투", accuracy: 100, alwaysHit: false, effect: null, counter: true },
  "버티기":   { power: 0,  type: "노말", accuracy: 100, alwaysHit: true,  effect: null, endure: true, targetSelf: true },
  "객기": { power: 40, type: "노말", accuracy: 100, alwaysHit: false, effect: null, guts: true },
  "씨뿌리기": { power: 0, type: "풀", accuracy: 90, alwaysHit: false, effect: null, leechSeed: true, targetSelf: false },
  "치유파동": { power: 0, type: "에스퍼", accuracy: 100, alwaysHit: true, effect: null, healPulse: true, targetSelf: false },
  "참기":     { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null, bide: true, targetSelf: true },

  // ───── 더블배틀 전용 전체공격 기술 (aoe: true) ─────
  // aoe: true → 클라이언트가 자동으로 자신 제외 전체(아군 + 적1 + 적2)를 targetSlots로 설정
  // 다중 타겟이므로 서버의 isAoe=true 분기 → 데미지 ×0.75 감쇄 적용
  "열폭풍":   { power: 45, type: "불",   accuracy: 100, alwaysHit: false, aoe: true, effect: { chance: 0.1, status: "화상" } },
  "대폭발":   { power: 60, type: "노말", accuracy: 100, alwaysHit: false, aoe: true, effect: null },
  "파괴광선": { power: 55, type: "노말", accuracy: 90,  alwaysHit: false, aoe: true, effect: null },
  "분노의앞니": { power: 45, type: "악",   accuracy: 95,  alwaysHit: false, aoe: true, effect: { chance: 0.2, volatile: "풀죽음" } },
  "회오리":   { power: 35, type: "비행", accuracy: 95,  alwaysHit: false, aoe: true, effect: null },
  "스케일노이즈": { power: 40, type: "드래곤", accuracy: 100, alwaysHit: false, aoe: true,
                    effect: null, rank: { targetDef: -1, turns: 2 } },

  // ───── 더블배틀 전용 적 전체공격 기술 (aoeEnemy: true) ─────
  // aoeEnemy: true → 아군 제외, 적 2마리 전원에게 자동 타겟
  // 다중 타겟이므로 서버의 isAoe=true 분기 → 데미지 ×0.75 감쇄 적용
  "화염방사기": { power: 45, type: "불",   accuracy: 100, alwaysHit: false, aoeEnemy: true, effect: { chance: 0.1, status: "화상" } },
  "냉동광선":   { power: 45, type: "얼음", accuracy: 100, alwaysHit: false, aoeEnemy: true, effect: { chance: 0.1, status: "얼음" } },
  "파도":       { power: 45, type: "물",   accuracy: 100, alwaysHit: false, aoeEnemy: true, effect: null },
  "사이코노이즈": { power: 40, type: "에스퍼", accuracy: 100, alwaysHit: false, aoeEnemy: true, effect: { chance: 0.1, volatile: "혼란" } },
}