// 피드 순수부 테스트 — 버퍼 규율(중복·정렬·상한)과 낭독 스펙 준수.
import { describe, expect, it } from "vitest";
import { actorOf, BUFFER_CAP, insertEntry, isSetMember, lineOf, ttsOf, type ActivityEntry } from "./feed";

const e = (seq: number, kind = "command.executed", payload: Record<string, unknown> = {}): ActivityEntry => ({
  seq,
  ts: seq,
  kind,
  source: "test",
  payload,
});

describe("insertEntry", () => {
  it("seq 중복은 버린다(백필∩라이브)", () => {
    const buf: ActivityEntry[] = [];
    expect(insertEntry(buf, e(1))).toBe(true);
    expect(insertEntry(buf, e(1))).toBe(false);
    expect(buf.length).toBe(1);
  });
  it("역순 도착도 seq 정렬로 복원한다", () => {
    const buf: ActivityEntry[] = [];
    insertEntry(buf, e(5));
    insertEntry(buf, e(3));
    insertEntry(buf, e(4));
    expect(buf.map((x) => x.seq)).toEqual([3, 4, 5]);
  });
  it("상한 초과 시 오래된 것부터 버린다", () => {
    const buf: ActivityEntry[] = [];
    for (let i = 0; i < BUFFER_CAP + 10; i++) insertEntry(buf, e(i));
    expect(buf.length).toBe(BUFFER_CAP);
    expect(buf[0].seq).toBe(10);
  });
});

describe("ttsOf — 낭독 스펙 준수", () => {
  it("payload.tts 문자열 = 그대로 낭독", () => {
    expect(ttsOf(e(1, "command.executed", { tts: "완료했어요" }), true)).toBe("완료했어요");
  });
  it("payload.tts 없음/false = 침묵 (turn.ended 포함)", () => {
    expect(ttsOf(e(1, "turn.ended", {}), true)).toBeNull();
    expect(ttsOf(e(2, "command.executed", { message: "m" }), true)).toBeNull();
    expect(ttsOf(e(3, "command.executed", { tts: false }), true)).toBeNull();
  });
  it("terminal.finished tts:true = 종료코드 문장 합성", () => {
    expect(ttsOf(e(1, "terminal.command.finished", { tts: true, exitCode: 0 }), true)).toContain("끝났어요");
    expect(ttsOf(e(2, "terminal.command.finished", { tts: true, exitCode: 2 }), true)).toContain("코드 2");
  });
});

describe("lineOf", () => {
  it("command.executed 는 오케스트레이터와 동형 요약", () => {
    const line = lineOf(e(1, "command.executed", { command: "x", ok: true, durationMs: 3, message: "done" }));
    expect(line).toBe("x ✓ (3ms) → done");
  });
  it("대화 세트(chat.*) — 질문·답변을 표시하되 tts 는 없다(자동 침묵)", () => {
    const prompt = e(1, "chat.prompt", { text: "창 알려줘", turnId: "t1" });
    const answer = e(2, "chat.answer", { text: "3개 열려 있어요", parentId: "t1" });
    expect(lineOf(prompt)).toBe("💬 창 알려줘");
    expect(lineOf(answer)).toBe("↩ 3개 열려 있어요");
    expect(ttsOf(prompt, true)).toBeNull();
    expect(ttsOf(answer, true)).toBeNull();
  });
});

describe("isSetMember — parentId 들여쓰기 마커", () => {
  it("payload.parentId 보유 엔트리만 세트 구성원", () => {
    expect(isSetMember(e(1, "command.executed", { parentId: "t1" }))).toBe(true);
    expect(isSetMember(e(2, "chat.prompt", { turnId: "t1" }))).toBe(false);
    expect(isSetMember(e(3, "command.executed", {}))).toBe(false);
  });
});

describe("actorOf — 발화자 라벨(§5 R3, 오케스트레이터 동형)", () => {
  it("origin 우선, 없으면 유래 소스, 사람 손은 무라벨", () => {
    expect(actorOf({ ...e(1), source: "remote", payload: { origin: "schedule" } }, true)).toBe("스케줄");
    expect(actorOf({ ...e(2), source: "ui", payload: { origin: "internal" } }, true)).toBe("내부");
    expect(actorOf({ ...e(3), source: "remote", payload: {} }, true)).toBe("원격");
    expect(actorOf({ ...e(4), source: "terminal", payload: {} }, true)).toBe("터미널");
    expect(actorOf({ ...e(5), source: "ui", payload: {} }, true)).toBe("");
  });
});
