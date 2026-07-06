// 피드 순수부 — 엔트리 버퍼(seq 중복 제거·정렬)와 표시 라인/낭독 문장 도출.
// 낭독 규칙(MESSAGE-PROTOCOL §3): 명령 실행은 payload.speak(명령 소유 문장)을 그대로 읽고,
// 이벤트(터미널 종료 등)는 낭독자가 kind 별로 자기 i18n 으로 문장을 구성한다. payload.speak 도
// 없고 kind 낭독도 없으면 침묵.
export interface ActivityEntry {
  seq: number;
  ts: number;
  kind: string;
  source: string;
  payload: Record<string, unknown>;
}

export const BUFFER_CAP = 300;

/** seq 기준 중복 제거 + 정렬 삽입(백필과 라이브가 겹쳐도 안전). 반환 = 추가 여부. */
export function insertEntry(buf: ActivityEntry[], e: ActivityEntry): boolean {
  if (buf.some((x) => x.seq === e.seq)) return false;
  buf.push(e);
  buf.sort((a, b) => a.seq - b.seq);
  if (buf.length > BUFFER_CAP) buf.splice(0, buf.length - BUFFER_CAP);
  return true;
}

/** 표시 한 줄 — 자기기술 엔트리(MESSAGE-PROTOCOL §3), 오케스트레이터 lineOf 와 동일 규칙.
 *  소비자는 kind 를 열거하지 않는다: 명령 트레이스(durationMs 보유)면 generic 프레이밍(도메인
 *  무지), 그 외는 산출자가 실은 message. 산출자가 자기 i18n 으로 문장을 소유한다. */
export function lineOf(e: ActivityEntry): string {
  const p = e.payload;
  if (typeof p.durationMs === "number") {
    const head = `${p.command} ${p.ok ? "✓" : `✗ ${p.code ?? ""}`} (${p.durationMs}ms)`;
    return p.message ? `${head} → ${p.message}` : head;
  }
  return typeof p.message === "string" && p.message ? p.message : e.kind;
}

/** 응답이 선언한 표시 미디어(MESSAGE-PROTOCOL) — 이미지는 이미지로(오케스트레이터 동형). */
export function mediaOf(e: ActivityEntry): { kind: string; base64?: string; path?: string } | null {
  const m = e.payload.media as { kind?: string; base64?: string; path?: string } | undefined;
  if (m && typeof m.kind === "string" && m.kind.startsWith("image/")) {
    return { kind: m.kind, base64: m.base64, path: m.path };
  }
  return null;
}

/** 대화 세트 구성원(payload.parentId 보유) — flat 사이드바의 들여쓰기 마커 대상. */
export function isSetMember(e: ActivityEntry): boolean {
  return typeof e.payload.parentId === "string" && e.payload.parentId !== "";
}

// 발화자 라벨 사전(§5 R3) — 선언적 {en,ko} 해소(플러그인 i18n 규칙). 키 추가 = 여기 1줄.
const ACTOR_LABELS: Record<string, { en: string; ko: string }> = {
  schedule: { en: "schedule", ko: "스케줄" },
  internal: { en: "internal", ko: "내부" },
  remote: { en: "remote", ko: "원격" },
  terminal: { en: "terminal", ko: "터미널" },
  plugin: { en: "plugin", ko: "플러그인" },
};
// 사람 손의 소스 — 무배지(행의 주인이 곧 사람). 오케스트레이터 actorKeyOf 와 동형 단일 규칙.
const HUMAN_SOURCES = new Set(["ui", "orchestrator"]);

/** 발화자 라벨(오케스트레이터 동형) — origin 우선, 없으면 비인간 소스가 곧 키. "" = 사람. */
export function actorOf(e: ActivityEntry, ko: boolean): string {
  const origin = typeof e.payload.origin === "string" ? e.payload.origin : "";
  const key = origin || (HUMAN_SOURCES.has(e.source) ? "" : e.source);
  if (!key) return "";
  const l = ACTOR_LABELS[key];
  return l ? (ko ? l.ko : l.en) : key;
}

/** 낭독 문장 — 산출자가 자기 i18n 으로 실은 payload.speak 를 그대로 읽는다(명령·이벤트·플러그인
 *  균일, MESSAGE-PROTOCOL §3). 낭독자는 kind 를 열거하거나 문장을 합성하지 않는다. 없으면 침묵. */
export function speakOf(e: ActivityEntry): string | null {
  const own = e.payload.speak;
  return typeof own === "string" && own.trim() ? own.trim() : null;
}
