// 피드 순수부 — 엔트리 버퍼(seq 중복 제거·정렬)와 표시 라인/낭독 문장 도출.
// 원칙(MESSAGE-PROTOCOL 낭독 스펙): payload.tts 가 있는 엔트리만 읽는다. 문자열=그 문장,
// true=종류별 로컬라이즈 합성. 소비자는 자체 읽기/건너뛰기 규칙을 만들지 않는다.
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

/** 표시 한 줄 — 오케스트레이터 lineOf 와 동형(같은 스트림이 같은 문장으로 보이게). */
export function lineOf(e: ActivityEntry): string {
  const p = e.payload;
  switch (e.kind) {
    case "command.executed": {
      const head = `${p.command} ${p.ok ? "✓" : `✗ ${p.code ?? ""}`} (${p.durationMs}ms)`;
      return p.message ? `${head} → ${p.message}` : head;
    }
    case "command.progress":
      return `⋯ ${p.command ? `${p.command}: ` : ""}${p.delta ?? ""}`;
    case "terminal.command.started":
      return `$ ${p.commandLine}`;
    case "terminal.command.finished":
      return `종료 ${p.exitCode ?? ""}`;
    case "turn.ended":
      return `턴 종료${p.agentKind ? ` (${p.agentKind})` : ""}${p.command ? ` — ${p.command}` : ""}`;
    case "view.activated":
      return `뷰 활성화 ${p.viewId}`;
    // 오케스트레이터 대화 세트(parentId 상관) — 사이드바는 flat 이므로 세트 구성원은
    // isSetMember 들여쓰기 마커로 묶임을 보인다. tts 는 어느 쪽에도 없다(자동 침묵).
    case "chat.prompt":
      return `💬 ${p.text ?? ""}`;
    case "chat.answer":
      return `↩ ${p.text ?? ""}`;
    default:
      return e.kind;
  }
}

/** 대화 세트 구성원(payload.parentId 보유) — flat 사이드바의 들여쓰기 마커 대상. */
export function isSetMember(e: ActivityEntry): boolean {
  return typeof e.payload.parentId === "string" && e.payload.parentId !== "";
}

/** 낭독 문장 — payload.tts 문자열은 그대로, true 는 종류별 합성, 그 외 null(침묵). */
export function ttsOf(e: ActivityEntry, ko: boolean): string | null {
  const t = e.payload.tts;
  if (typeof t === "string" && t.trim()) return t.trim();
  if (t !== true) return null;
  if (e.kind === "terminal.command.finished") {
    const code = typeof e.payload.exitCode === "number" ? e.payload.exitCode : null;
    if (code === 0 || code == null) return ko ? "터미널 명령이 끝났어요." : "A terminal command finished.";
    return ko ? `명령이 실패했어요. 코드 ${code}.` : `A command failed with code ${code}.`;
  }
  // tts:true 인데 전용 합성이 없는 종류 — 표시 라인을 그대로 읽는다(스펙: 낭독 대상임은 확실).
  return lineOf(e);
}
