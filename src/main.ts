// soksak-plugin-activity — 프로젝트 창 사이드바의 활동로그(허브 전체 스트림) + mascot 낭독.
// 데이터: 백필 activity.recent 1회 + 라이브 app.events.on("activity") — 폴링 0, 필터 없음
// (오케스트레이터 피드와 동일 내용이 수용 기준).
// 낭독 규율: payload.tts 스펙 준수 + 읽음 커서(kv 공유) + 낭독자 선출(단일 목소리).
//   여러 프로젝트 창 중 "마지막으로 포커스된 창"이 낭독자(kv 클레임) — 오케스트레이터/타 앱으로
//   포커스가 가도 낭독자는 유지된다(오케스트레이터 창은 설계상 플러그인이 없다 — P13 셸).
//   낭독 자격 = 낭독자 OR 타겟된 창(엔트리가 이 창에서 발생 — relay ownWindow). 자격 없는
//   도착분은 "안 읽음" 적립, 낭독자가 되면 소화하되 백로그 3개 초과면 마지막 3개만 읽고
//   전체 읽음 처리(커서 일괄 전진 — 밀린 독백 방지). say 는 spec tts:false 라 되먹임 불가.
import { actorOf, BUFFER_CAP, insertEntry, isSetMember, lineOf, mediaOf, ttsOf, type ActivityEntry } from "./feed";

interface Disposable {
  dispose(): void;
}
interface HostApp {
  locale?: () => string;
  windowLabel?: () => string;
  ui: {
    registerView(
      id: string,
      provider: {
        mount(c: HTMLElement, ctx: { setBadge?: (b: number | "dot" | null) => void }): void;
        unmount?(c: HTMLElement): void;
      },
    ): Disposable;
  };
  commands: {
    register(name: string, spec: Record<string, unknown> & { handler: Function }): Disposable;
    // opts.origin — 자동 행위의 자기 선언(§5): 기록은 되고 노출(흐림·무낭독)만 낮아진다.
    execute(name: string, params?: Record<string, unknown>, opts?: { origin?: string }): Promise<any>;
  };
  events: { on(event: string, fn: (payload: any) => void): Disposable };
  settings: { get(key: string): unknown; onChange(cb: (all: Record<string, unknown>) => void): Disposable };
  data?: {
    kv: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<void>;
      watch(cb: (key: string) => void): Disposable;
    };
  };
  // fs:read 권한 — 응답 media(path 모드) 이미지 렌더용(오케스트레이터 동형).
  fs?: { readBinary?: (path: string) => Promise<{ mime: string; base64: string }> };
}
interface PluginCtx {
  app: HostApp;
  subscriptions: Array<Disposable | (() => void)>;
}

const VT = "plugin.soksak-plugin-mascot.";

// 낭독자 kv 판독 — 신형 {id, window} / 구형 string(id) 겸용.
function narratorIdOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id;
  return null;
}
function narratorWindowOf(v: unknown): string | null {
  if (v && typeof v === "object" && typeof (v as { window?: unknown }).window === "string")
    return (v as { window: string }).window;
  return null;
}
const VERSION = "1.0.0";

export default {
  activate(ctx: PluginCtx) {
    const app = ctx.app;
    const ko = (app.locale?.() ?? "ko").startsWith("ko");
    const buf: ActivityEntry[] = [];
    const narrated = new Set<number>(); // seq — list 커맨드/검증용(이 창이 읽은 것)
    const viewListeners = new Set<() => void>();
    let mascotWarned = false;
    // 읽음 커서(watermark) — "어디까지 읽었는지"의 단일 진실. kv 영속 + 창 간 공유(watch)로
    // 리로드/다중 창에서 같은 엔트리를 중복 낭독하지 않는다. 커서 이하 seq 는 절대 읽지 않는다.
    const CURSOR_KEY = "narratedSeq";
    let cursor = -1;
    let cursorReady = false; // kv 로드 전엔 낭독 보류(과거 몰아읽기 방지)
    const loadCursor = app.data?.kv
      .get(CURSOR_KEY)
      .then((v) => {
        if (typeof v === "number") cursor = v;
      })
      .catch(() => {})
      .finally(() => {
        cursorReady = true;
      });
    if (app.data?.kv.watch)
      ctx.subscriptions.push(
        app.data.kv.watch((key) => {
          if (key === CURSOR_KEY) {
            void app.data!.kv.get(CURSOR_KEY).then((v) => {
              if (typeof v === "number" && v > cursor) cursor = v; // 다른 창이 전진 — 따라간다
            });
          } else if (key === NARRATOR_KEY) {
            void app.data!.kv.get(NARRATOR_KEY).then((v) => {
              const was = isNarrator;
              isNarrator = narratorIdOf(v) === myId; // 다른 창이 클레임 — 즉시 양보(단일 목소리)
              // 자격 상실 = 엔진 반납(규칙: 엔진의 생존은 발화 자격과 함께 간다 — 모델 상주
              // 프로세스가 창마다 남아 메모리를 먹던 원천). 다음 자격 창이 lazy 재기동.
              if (was && !isNarrator) void app.commands.execute(VT + "release", {}, { origin: "internal" }).catch(() => {});
              if (was !== isNarrator) syncMascot(); // 자격 이동 = 마스코트 표시도 이동
            });
          } else if (key === MASCOT_KEY) {
            void app.data!.kv.get(MASCOT_KEY).then((v) => {
              mascot = v !== false;
              syncMascot();
              if (mascot) drainUnread();
              else void app.commands.execute(VT + "release", {}, { origin: "internal" }).catch(() => {}); // 끔 = 자격 반납
              notify();
            });
          }
        }),
      );
    const advanceCursor = (seq: number) => {
      if (seq <= cursor) return false;
      cursor = seq; // 로컬 즉시 전진(레이스 창 최소화) 후 영속
      void app.data?.kv.set(CURSOR_KEY, seq).catch(() => {});
      return true;
    };

    // mascot 플래그 — kv 가 단일 진실(선언형 설정 스토어는 창-로컬이라 창 간 불일치).
    // 커서·낭독자와 동일한 동기 채널(kv watch)로 전 창이 즉시 일치한다.
    const MASCOT_KEY = "mascot";
    let mascot = true;
    const mascotOn = () => mascot;
    void app.data?.kv.get(MASCOT_KEY).then((v) => {
      if (v === false) mascot = false;
      notify();
    });
    // 낭독자 선출 — kv "narrator" 를 포커스 획득 시 클레임. 값==내 id 인 인스턴스만 발화
    // (커서 공유가 중복을 이중 차단). 클레임은 유지형: 앱/창 포커스를 잃어도 다른 창이
    // 클레임하기 전까지 낭독자다(오케스트레이터 콘솔 실행도 끊김 없이 읽힌다).
    const NARRATOR_KEY = "narrator";
    const myId = (globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 12);
    let isNarrator = false;
    const claimNarrator = () => {
      const was = isNarrator;
      isNarrator = true;
      // 창 label 동봉 — 부트 시 "낭독자 창이 아직 살아있나"를 실존 대조로 판정(하트비트·폴링 없이).
      void app.data?.kv.set(NARRATOR_KEY, { id: myId, window: app.windowLabel?.() ?? "" }).catch(() => {});
      if (!was) syncMascot(); // 자격 획득 = 이 창에 마스코트
    };

    const notify = () => {
      for (const fn of viewListeners) fn();
    };

    // 낭독 — 스펙 준수 + 읽음 커서 + 단일 낭독자: tts 문장이 있고 커서를 전진시킨 엔트리만 say.
    // (커서 이하 = 이미 읽음(이 창/다른 창/이전 세션) — 침묵. 몰아읽기·중복 낭독 원천 차단.)
    // 목소리는 항상 하나 — narrator 만 읽는다. 과거의 "발생 창 병행 낭독권"은 크로스창 턴
    // (오케스트레이터)에서 narrator 와 발생 창이 동시 발화하는 레이스를 만들어 폐지(실측).
    // 활성창 규칙은 포커스 시 narrator 클레임이 담당한다(작업 창 = 낭독 창).
    const narrate = (e: ActivityEntry) => {
      if (!mascotOn() || !cursorReady || !isNarrator) return;
      const text = ttsOf(e, ko);
      if (!text) return;
      if (!advanceCursor(e.seq)) return;
      narrated.add(e.seq);
      void app.commands.execute(VT + "say", { text }, { origin: "internal" }).catch((err) => {
        if (!mascotWarned) {
          mascotWarned = true;
          console.warn("[activity] mascot say 실패 — 텍스트 모드로 계속:", err);
        }
      });
    };

    /** 안 읽은 tts 엔트리(커서 초과) — 표시·배지·포커스 획득 시 소화 대상. */
    const unreadEntries = () => buf.filter((e) => e.seq > cursor && ttsOf(e, ko) !== null);

    /** 밀린 안 읽음 소화 — 낭독자 획득/mascot 켬 시. 3개 초과 백로그는 마지막 3개만 읽고
     *  나머지는 커서 일괄 전진으로 읽음 처리(몰아 읽기 독백 방지 — 사용자 규칙). */
    const drainUnread = () => {
      if (!mascotOn() || !cursorReady || !isNarrator) return;
      const u = unreadEntries();
      if (u.length > 3) advanceCursor(u[u.length - 4].seq); // 마지막 3개 직전까지 읽음 처리
      for (const e of u.slice(-3)) narrate(e);
      notify();
    };

    // 포커스 획득 = 낭독자 클레임(이 창이 사용자의 현재 작업 창) + 밀린 것 소화
    ctx.subscriptions.push(
      app.events.on("app.focus", (p: { focused: boolean }) => {
        if (p.focused === true) {
          claimNarrator();
          drainUnread();
        }
        notify();
      }),
    );
    // 활성화 시점: 현재 포커스 창이면 즉시 클레임, 아니면 기존 낭독자 부재 시에만 클레임(첫 창)
    if (typeof document !== "undefined" && document.hasFocus()) claimNarrator();
    else
      void app.data?.kv.get(NARRATOR_KEY).then(async (v) => {
        if (v == null) return claimNarrator();
        isNarrator = narratorIdOf(v) === myId;
        if (isNarrator) return;
        // 죽은 낭독자 승계 — 기록된 창이 더는 없으면(닫힘) 자격은 무주공산이다. 표시가 자격에
        // 묶인 뒤로 이 엣지는 "유일한 창인데 마스코트 없음"으로 표면화된다(실측). 실존 대조 1회.
        const w = narratorWindowOf(v);
        if (w === null) return claimNarrator(); // 구형 기록(창 미상) — 재클레임으로 신형 전환
        try {
          const r = await app.commands.execute("window.list", {}, { origin: "internal" });
          const labels = ((r?.data?.labels ?? r?.labels ?? []) as string[]) || [];
          if (!labels.includes(w)) claimNarrator();
        } catch {
          /* 대조 불가 — 다음 포커스 획득이 자연 승계 */
        }
      });

    const ingest = (e: ActivityEntry, live: boolean) => {
      if (!insertEntry(buf, e)) return;
      if (live) narrate(e); // 백필은 과거 — 낭독하지 않는다(라이브만). 자격 없으면 안 읽음 적립
      notify();
    };

    // 라이브 — 허브 전체 스트림(창 필터 없음: 오케스트레이터와 동일 내용)
    ctx.subscriptions.push(
      app.events.on("activity", (e: ActivityEntry & { ownWindow?: boolean }) => {
        const { ownWindow, ...entry } = e;
        void ownWindow; // 낭독권 아님(단일 낭독자) — 창-스코프 표시 필터용 필드만 소비
        ingest(entry as ActivityEntry, true);
      }),
    );

    // 백필 1회 — 표시만(낭독 없음). 커서는 백필 최대 seq 까지 전진: 과거는 영원히 과거다.
    void Promise.resolve(loadCursor).then(() =>
      app.commands
        .execute("activity.recent", { limit: 100 }, { origin: "internal" })
        .then((r: any) => {
          const entries = (r?.data?.entries ?? r?.entries ?? []) as ActivityEntry[];
          for (const e of entries) ingest(e, false);
          const maxSeq = entries.reduce((m, e) => Math.max(m, e.seq), -1);
          // 커서 불변식: 최신 seq 를 초과할 수 없다. 초과 = 유실 잔재(허브 영속 결번 등으로
          // 재시작 재개점이 과거 커서보다 낮은 경우) — 그대로 두면 모든 새 엔트리가 "이미
          // 읽음"이 되어 낭독이 전면 침묵한다(실측). 최신으로 스냅해 불변식을 복원한다.
          if (maxSeq >= 0 && cursor > maxSeq) {
            cursor = maxSeq;
            void app.data?.kv.set(CURSOR_KEY, maxSeq).catch(() => {});
          }
          if (maxSeq >= 0) advanceCursor(maxSeq);
        })
        .catch(() => {}),
    );

    // 마스코트 동기 — mascot 토글이 캐릭터 표시까지 소유(on=등장, off=퇴장)
    // 마스코트 표시 자격 = 낭독자(단일 낭독자와 동형): 낭독자 창만 그린다. 모든 창이 각자
    // Live2D 를 상시 렌더하면 창당 CPU ~3%p(실측, rAF+매 프레임 스타일 갱신)가 배가된다 —
    // 목소리가 하나면 얼굴도 하나. 자격 이동(narrator kv)이 표시도 함께 옮긴다.
    const syncMascot = () => {
      void app.commands.execute(VT + "toggle", { on: mascotOn() && isNarrator }, { origin: "internal" }).catch(() => {});
    };
    syncMascot();

    // ── 뷰 ──
    ctx.subscriptions.push(
      app.ui.registerView("log", {
        mount(container: HTMLElement, viewCtx: { setBadge?: (b: number | "dot" | null) => void }) {
          container.style.position = "relative";
          const shadow = container.shadowRoot ?? container.attachShadow({ mode: "open" });
          shadow.replaceChildren();
          const style = document.createElement("style");
          style.textContent = `
:host { all: initial; }
.al-root { position:absolute; inset:0; display:flex; flex-direction:column; font:12px/1.45 system-ui,sans-serif; color:#d8d8e0; }
.al-bar { display:flex; gap:6px; padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.08); align-items:center; }
.al-btn { padding:3px 9px; border-radius:7px; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.08); color:inherit; cursor:pointer; font:inherit; font-size:11px; }
.al-log { flex:1; overflow-y:auto; padding:6px 8px; display:flex; flex-direction:column; gap:3px; }
/* 스크롤바 — 코어 정본(App.css 4px)과 동일: 플러그인 뷰(Shadow DOM)엔 전역 규칙이 안 들어온다. */
.al-log::-webkit-scrollbar { -webkit-appearance:none; width:4px; height:4px; }
.al-log::-webkit-scrollbar-track { background:transparent; }
.al-log::-webkit-scrollbar-thumb { background:rgba(127,127,127,.22); border-radius:2px; }
.al-log::-webkit-scrollbar-thumb:hover { background:rgba(127,127,127,.42); }
.al-row { display:flex; gap:6px; align-items:baseline; }
.al-time { color:#8a8a96; font-size:10px; flex:none; }
.al-text { white-space:pre-wrap; word-break:break-all; }
.al-row.k-command-executed .al-text { color:#cfd8ff; }
.al-row.k-terminal-command-finished .al-text { color:#bfe3bf; }
.al-row.k-turn-ended .al-text { color:#e8c8d8; }
.al-row.k-chat-prompt .al-text { color:#ffd9a8; font-weight:600; }
.al-row.k-chat-answer .al-text { color:#ffd9a8; }
/* 대화 세트 구성원(parentId) — flat 로그의 들여쓰기 마커(오케스트레이터 카드와 같은 묶음). */
.al-row.set { padding-left:14px; border-left:2px solid rgba(255,207,92,.35); }
/* 시스템 유래(§5 — 스케줄러·부팅 부산물) — 기록은 보이되 흐림. */
.al-row.sys { opacity:.38; }
/* 발화자 배지(§5 R3, 오케스트레이터 동형 칩). */
.al-actor { display:inline-block; margin-left:5px; padding:0 5px; border-radius:7px; font-size:9px; line-height:13px; vertical-align:middle; border:1px solid rgba(255,255,255,.22); background:rgba(255,255,255,.08); }
.al-row.spoken .al-time::after { content:"🔊"; margin-left:2px; }
.al-row.unread .al-text { color:#ffe9a8; }
.al-row.unread .al-time::before { content:"●"; color:#ffcf5c; margin-right:3px; }
.al-empty { color:#8a8a96; padding:12px; text-align:center; }
/* 응답 표시 미디어 — 이미지는 이미지로(오케스트레이터 동형, MESSAGE-PROTOCOL media). */
.al-shot { display:block; max-width:100%; border-radius:6px; margin:3px 0 3px 46px; }
`;
          shadow.appendChild(style);
          const root = document.createElement("div");
          root.className = "al-root";
          shadow.appendChild(root);
          const bar = document.createElement("div");
          bar.className = "al-bar";
          const toggle = document.createElement("button");
          toggle.className = "al-btn";
          bar.appendChild(toggle);
          const log = document.createElement("div");
          log.className = "al-log";
          root.append(bar, log);

          const renderBar = () => {
            toggle.textContent = mascotOn()
              ? ko ? "브이튜브 켬" : "mascot on"
              : ko ? "브이튜브 끔" : "mascot off";
          };
          toggle.onclick = () => void app.commands.execute("plugin.soksak-plugin-activity.mascot.toggle", {});

          const render = () => {
            renderBar();
            log.replaceChildren();
            if (buf.length === 0) {
              const em = document.createElement("div");
              em.className = "al-empty";
              em.textContent = ko ? "아직 활동이 없어요" : "no activity yet";
              log.appendChild(em);
              return;
            }
            const unreadSet = new Set(unreadEntries().map((x) => x.seq));
            viewCtx.setBadge?.(unreadSet.size > 0 ? unreadSet.size : null);
            for (const e of buf) {
              const row = document.createElement("div");
              row.className = `al-row k-${e.kind.split(".").join("-")}${narrated.has(e.seq) ? " spoken" : ""}${unreadSet.has(e.seq) ? " unread" : ""}${isSetMember(e) ? " set" : ""}${typeof e.payload.origin === "string" && e.payload.origin ? " sys" : ""}`;
              const t = document.createElement("span");
              t.className = "al-time";
              t.textContent = new Date(e.ts).toTimeString().slice(0, 8);
              const actor = actorOf(e, ko);
              if (actor) {
                const chip = document.createElement("span");
                chip.className = "al-actor";
                chip.textContent = actor;
                t.appendChild(chip);
              }
              const x = document.createElement("span");
              x.className = "al-text";
              x.textContent = lineOf(e);
              row.append(t, x);
              log.appendChild(row);
              // 응답이 media 를 선언하면 이미지로 렌더(오케스트레이터 동형 — 경로 문자열 금지).
              const media = mediaOf(e);
              if (media) {
                const img = document.createElement("img");
                img.className = "al-shot";
                img.alt = "";
                if (media.base64) img.src = `data:${media.kind};base64,${media.base64}`;
                else if (media.path && app.fs?.readBinary) {
                  void app.fs
                    .readBinary(media.path)
                    .then((f) => {
                      img.src = `data:${f.mime};base64,${f.base64}`;
                    })
                    .catch(() => img.remove()); // 파일 소실 등 — 조용히 생략(오케 동형)
                }
                log.appendChild(img);
              }
            }
            log.scrollTop = log.scrollHeight;
          };
          const listener = render;
          viewListeners.add(listener);
          render();
          (container as HTMLElement & { _alDispose?: () => void })._alDispose = () =>
            viewListeners.delete(listener);
        },
        unmount(container: HTMLElement) {
          (container as HTMLElement & { _alDispose?: () => void })._alDispose?.();
        },
      }),
    );

    // ── 커맨드 ──
    const reg = (name: string, spec: Record<string, unknown> & { handler: Function }) =>
      ctx.subscriptions.push(app.commands.register(name, spec));

    reg("ping", {
      description: "Health check — plugin load/version probe (E2E).",
      triggers: { ko: "활동 플러그인 상태 점검 핑" },
      handler: () => ({ ok: true, plugin: "soksak-plugin-activity", version: VERSION }),
    });

    reg("list", {
      description:
        "List buffered activity entries (same hub stream the orchestrator shows). narrated marks entries actually spoken.",
      triggers: { ko: "활동 로그 목록 조회" },
      params: { limit: { type: "number", description: "max entries (default 20)", required: false } },
      returns: "{ ok, cursor, unreadCount, entries: [{seq, ts, kind, text, tts, narrated, unread}] }",
      handler: (p: Record<string, unknown>) => {
        const limit = typeof p.limit === "number" ? Math.max(1, p.limit) : 20;
        return {
          ok: true,
          cursor,
          unreadCount: unreadEntries().length,
          // 진단 — 이 응답을 만든 인스턴스의 시야(창별 상태 어긋남 추적)
          me: { id: myId, narrator: isNarrator, mascot: mascotOn() },
          entries: buf.slice(-limit).map((e) => ({
            seq: e.seq,
            ts: e.ts,
            kind: e.kind,
            text: lineOf(e),
            tts: ttsOf(e, ko),
            narrated: narrated.has(e.seq),
            unread: e.seq > cursor && ttsOf(e, ko) !== null,
          })),
        };
      },
    });

    reg("mascot.toggle", {
      speak: () => "", // 낭독 제어 계열 — 자기 조작 무낭독(§3)
      description: "Toggle character narration + mascot (persists via the mascot setting).",
      triggers: { ko: "브이튜브 낭독 마스코트 켜기 끄기" },
      params: { on: { type: "boolean", description: "explicit state; omit to flip", required: false } },
      handler: async (p: Record<string, unknown>) => {
        const next = typeof p.on === "boolean" ? p.on : !mascotOn();
        mascot = next; // 이 창 즉시 확정 — 타 창은 kv watch 로 따라온다
        // 토글이 실행된 창 = 명시적 사용자 의도 → 낭독자 클레임(리로드로 고아가 된 클레임도 회복)
        claimNarrator();
        await app.data?.kv.set(MASCOT_KEY, next).catch(() => {});
        await app.commands.execute(VT + "toggle", { on: next }).catch(() => {});
        if (next) drainUnread();
        notify();
        return { ok: true, mascot: next };
      },
    });
  },
};
