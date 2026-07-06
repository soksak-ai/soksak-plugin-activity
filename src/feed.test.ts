// 피드 순수부 테스트 — 버퍼 규율(중복·정렬·상한)과 낭독 스펙 준수.
import { describe, expect, it } from "vitest";
import { actorOf, BUFFER_CAP, insertEntry, isSetMember, lineOf, speakOf, type ActivityEntry } from "./feed";

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

describe("speakOf — 산출자 소유 낭독(§3, kind 무지)", () => {
  it("payload.speak 문자열 = 그대로 낭독", () => {
    expect(speakOf(e(1, "command.executed", { speak: "완료했어요" }))).toBe("완료했어요");
    expect(speakOf(e(2, "terminal.command.finished", { speak: "터미널 명령이 끝났어요." }))).toBe(
      "터미널 명령이 끝났어요.",
    );
  });
  it("payload.speak 없음/빈문자열 = 침묵 — 낭독자는 합성하지 않는다", () => {
    expect(speakOf(e(1, "turn.ended", {}))).toBeNull();
    expect(speakOf(e(2, "command.executed", { message: "m" }))).toBeNull();
    expect(speakOf(e(3, "terminal.command.finished", { exitCode: 2 }))).toBeNull();
    expect(speakOf(e(4, "command.executed", { speak: "  " }))).toBeNull();
  });
});

describe("lineOf — 자기기술(kind 무지)", () => {
  it("명령 트레이스(durationMs)는 generic 프레이밍", () => {
    const line = lineOf(e(1, "command.executed", { command: "x", ok: true, durationMs: 3, message: "done" }));
    expect(line).toBe("x ✓ (3ms) → done");
  });
  it("그 외는 산출자 message 그대로 — 없으면 kind", () => {
    expect(lineOf(e(1, "chat.prompt", { text: "창 알려줘", message: "💬 창 알려줘" }))).toBe("💬 창 알려줘");
    expect(lineOf(e(2, "terminal.command.finished", { exitCode: 0, message: "종료 0" }))).toBe("종료 0");
    expect(lineOf(e(3, "some.kind", {}))).toBe("some.kind");
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
