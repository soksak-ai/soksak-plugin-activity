// soksak-plugin-activity — 프로젝트 창 사이드바의 활동로그(허브 전체 스트림) + vtube 낭독.
// 데이터: 백필 activity.recent 1회 + 라이브 app.events.on("activity") — 폴링 0, 필터 없음
// (오케스트레이터 피드와 동일 내용이 수용 기준). 낭독: payload.tts 스펙 준수(스킵 없음,
// 도착 순서대로 vtube-tts.say — say 는 spec tts:false 라 되먹임 불가).
import { BUFFER_CAP, insertEntry, lineOf, ttsOf, type ActivityEntry } from "./feed";

interface Disposable {
  dispose(): void;
}
interface HostApp {
  locale?: () => string;
  ui: {
    registerView(
      id: string,
      provider: { mount(c: HTMLElement, ctx: unknown): void; unmount?(c: HTMLElement): void },
    ): Disposable;
  };
  commands: {
    register(name: string, spec: Record<string, unknown> & { handler: Function }): Disposable;
    execute(name: string, params?: Record<string, unknown>): Promise<any>;
  };
  events: { on(event: string, fn: (payload: any) => void): Disposable };
  settings: { get(key: string): unknown; onChange(cb: (all: Record<string, unknown>) => void): Disposable };
}
interface PluginCtx {
  app: HostApp;
  subscriptions: Array<Disposable | (() => void)>;
}

const VT = "plugin.soksak-plugin-vtube-tts.";
const VERSION = "1.0.0";

export default {
  activate(ctx: PluginCtx) {
    const app = ctx.app;
    const ko = (app.locale?.() ?? "ko").startsWith("ko");
    const buf: ActivityEntry[] = [];
    const narrated = new Set<number>(); // seq — list 커맨드/검증용
    const viewListeners = new Set<() => void>();
    let vtubeWarned = false;

    const vtubeOn = () => app.settings.get("vtube") !== false;

    const notify = () => {
      for (const fn of viewListeners) fn();
    };

    // 낭독 — 스펙 준수만: tts 문장이 있으면 도착 순서대로 say(스킵 없음). 실패는 1회 경고.
    const narrate = (e: ActivityEntry) => {
      if (!vtubeOn()) return;
      const text = ttsOf(e, ko);
      if (!text) return;
      narrated.add(e.seq);
      void app.commands.execute(VT + "say", { text }).catch((err) => {
        if (!vtubeWarned) {
          vtubeWarned = true;
          console.warn("[activity] vtube-tts say 실패 — 텍스트 모드로 계속:", err);
        }
      });
    };

    const ingest = (e: ActivityEntry, live: boolean) => {
      if (!insertEntry(buf, e)) return;
      if (live) narrate(e); // 백필은 과거 — 낭독하지 않는다(라이브만)
      notify();
    };

    // 라이브 — 허브 전체 스트림(창 필터 없음: 오케스트레이터와 동일 내용)
    ctx.subscriptions.push(
      app.events.on("activity", (e: ActivityEntry & { ownWindow?: boolean }) => {
        const { ownWindow: _own, ...entry } = e;
        ingest(entry as ActivityEntry, true);
      }),
    );

    // 백필 1회
    void app.commands
      .execute("activity.recent", { limit: 100 })
      .then((r: any) => {
        for (const e of r?.data?.entries ?? r?.entries ?? []) ingest(e as ActivityEntry, false);
      })
      .catch(() => {});

    // 마스코트 동기 — vtube 토글이 캐릭터 표시까지 소유(on=등장, off=퇴장)
    const syncMascot = () => {
      void app.commands.execute(VT + "mascot.toggle", { on: vtubeOn() }).catch(() => {});
    };
    ctx.subscriptions.push(app.settings.onChange(() => {
      syncMascot();
      notify();
    }));
    syncMascot();

    // ── 뷰 ──
    ctx.subscriptions.push(
      app.ui.registerView("log", {
        mount(container: HTMLElement) {
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
.al-row { display:flex; gap:6px; align-items:baseline; }
.al-time { color:#8a8a96; font-size:10px; flex:none; }
.al-text { white-space:pre-wrap; word-break:break-all; }
.al-row.k-command-executed .al-text { color:#cfd8ff; }
.al-row.k-terminal-command-finished .al-text { color:#bfe3bf; }
.al-row.k-turn-ended .al-text { color:#e8c8d8; }
.al-row.spoken .al-time::after { content:"🔊"; margin-left:2px; }
.al-empty { color:#8a8a96; padding:12px; text-align:center; }
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
            toggle.textContent = vtubeOn()
              ? ko ? "브이튜브 켬" : "vtube on"
              : ko ? "브이튜브 끔" : "vtube off";
          };
          toggle.onclick = () => void app.commands.execute("plugin.soksak-plugin-activity.vtube.toggle", {});

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
            for (const e of buf) {
              const row = document.createElement("div");
              row.className = `al-row k-${e.kind.split(".").join("-")}${narrated.has(e.seq) ? " spoken" : ""}`;
              const t = document.createElement("span");
              t.className = "al-time";
              t.textContent = new Date(e.ts).toTimeString().slice(0, 8);
              const x = document.createElement("span");
              x.className = "al-text";
              x.textContent = lineOf(e);
              row.append(t, x);
              log.appendChild(row);
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
      returns: "{ ok, entries: [{seq, ts, kind, text, tts, narrated}] }",
      handler: (p: Record<string, unknown>) => {
        const limit = typeof p.limit === "number" ? Math.max(1, p.limit) : 20;
        return {
          ok: true,
          entries: buf.slice(-limit).map((e) => ({
            seq: e.seq,
            ts: e.ts,
            kind: e.kind,
            text: lineOf(e),
            tts: ttsOf(e, ko),
            narrated: narrated.has(e.seq),
          })),
        };
      },
    });

    reg("vtube.toggle", {
      description: "Toggle character narration + mascot (persists via the vtube setting).",
      triggers: { ko: "브이튜브 낭독 마스코트 켜기 끄기" },
      params: { on: { type: "boolean", description: "explicit state; omit to flip", required: false } },
      handler: async (p: Record<string, unknown>) => {
        const next = typeof p.on === "boolean" ? p.on : !vtubeOn();
        await app.commands.execute("plugin.settings.set", {
          id: "soksak-plugin-activity",
          key: "vtube",
          value: next,
        });
        return { ok: true, vtube: next };
      },
    });
  },
};
