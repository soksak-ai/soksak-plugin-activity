// src/feed.ts
var BUFFER_CAP = 300;
function insertEntry(buf, e) {
  if (buf.some((x) => x.seq === e.seq)) return false;
  buf.push(e);
  buf.sort((a, b) => a.seq - b.seq);
  if (buf.length > BUFFER_CAP) buf.splice(0, buf.length - BUFFER_CAP);
  return true;
}
function lineOf(e) {
  const p = e.payload;
  switch (e.kind) {
    case "command.executed": {
      const head = `${p.command} ${p.ok ? "\u2713" : `\u2717 ${p.code ?? ""}`} (${p.durationMs}ms)`;
      return p.message ? `${head} \u2192 ${p.message}` : head;
    }
    case "command.progress":
      return `\u22EF ${p.command ? `${p.command}: ` : ""}${p.delta ?? ""}`;
    case "terminal.command.started":
      return `$ ${p.commandLine}`;
    case "terminal.command.finished":
      return `\uC885\uB8CC ${p.exitCode ?? ""}`;
    case "turn.ended":
      return `\uD134 \uC885\uB8CC${p.agentKind ? ` (${p.agentKind})` : ""}${p.command ? ` \u2014 ${p.command}` : ""}`;
    case "view.activated":
      return `\uBDF0 \uD65C\uC131\uD654 ${p.viewId}`;
    // 오케스트레이터 대화 세트(parentId 상관) — 사이드바는 flat 이므로 세트 구성원은
    // isSetMember 들여쓰기 마커로 묶임을 보인다. tts 는 어느 쪽에도 없다(자동 침묵).
    case "chat.prompt":
      return `\u{1F4AC} ${p.text ?? ""}`;
    case "chat.answer":
      return `\u21A9 ${p.text ?? ""}`;
    case "boot.error":
      return `\uCC3D \uBD80\uD305 \uC624\uB958 \u2014 ${p.msg ?? ""}`;
    default:
      return e.kind;
  }
}
function mediaOf(e) {
  const m = e.payload.media;
  if (m && typeof m.kind === "string" && m.kind.startsWith("image/")) {
    return { kind: m.kind, base64: m.base64, path: m.path };
  }
  return null;
}
function isSetMember(e) {
  return typeof e.payload.parentId === "string" && e.payload.parentId !== "";
}
var ACTOR_LABELS = {
  schedule: { en: "schedule", ko: "\uC2A4\uCF00\uC904" },
  internal: { en: "internal", ko: "\uB0B4\uBD80" },
  remote: { en: "remote", ko: "\uC6D0\uACA9" },
  terminal: { en: "terminal", ko: "\uD130\uBBF8\uB110" },
  plugin: { en: "plugin", ko: "\uD50C\uB7EC\uADF8\uC778" }
};
var HUMAN_SOURCES = /* @__PURE__ */ new Set(["ui", "orchestrator"]);
function actorOf(e, ko) {
  const origin = typeof e.payload.origin === "string" ? e.payload.origin : "";
  const key = origin || (HUMAN_SOURCES.has(e.source) ? "" : e.source);
  if (!key) return "";
  const l = ACTOR_LABELS[key];
  return l ? ko ? l.ko : l.en : key;
}
function ttsOf(e, ko) {
  const t = e.payload.tts;
  if (typeof t === "string" && t.trim()) return t.trim();
  if (t !== true) return null;
  if (e.kind === "terminal.command.finished") {
    const code = typeof e.payload.exitCode === "number" ? e.payload.exitCode : null;
    if (code === 0 || code == null) return ko ? "\uD130\uBBF8\uB110 \uBA85\uB839\uC774 \uB05D\uB0AC\uC5B4\uC694." : "A terminal command finished.";
    return ko ? `\uBA85\uB839\uC774 \uC2E4\uD328\uD588\uC5B4\uC694. \uCF54\uB4DC ${code}.` : `A command failed with code ${code}.`;
  }
  return lineOf(e);
}

// src/main.ts
var VT = "plugin.soksak-plugin-vtube-tts.";
var VERSION = "1.0.0";
var main_default = {
  activate(ctx) {
    const app = ctx.app;
    const ko = (app.locale?.() ?? "ko").startsWith("ko");
    const buf = [];
    const narrated = /* @__PURE__ */ new Set();
    const viewListeners = /* @__PURE__ */ new Set();
    let vtubeWarned = false;
    const CURSOR_KEY = "narratedSeq";
    let cursor = -1;
    let cursorReady = false;
    const loadCursor = app.data?.kv.get(CURSOR_KEY).then((v) => {
      if (typeof v === "number") cursor = v;
    }).catch(() => {
    }).finally(() => {
      cursorReady = true;
    });
    if (app.data?.kv.watch)
      ctx.subscriptions.push(
        app.data.kv.watch((key) => {
          if (key === CURSOR_KEY) {
            void app.data.kv.get(CURSOR_KEY).then((v) => {
              if (typeof v === "number" && v > cursor) cursor = v;
            });
          } else if (key === NARRATOR_KEY) {
            void app.data.kv.get(NARRATOR_KEY).then((v) => {
              const was = isNarrator;
              isNarrator = v === myId;
              if (was && !isNarrator) void app.commands.execute(VT + "release", {}, { origin: "internal" }).catch(() => {
              });
            });
          } else if (key === VTUBE_KEY) {
            void app.data.kv.get(VTUBE_KEY).then((v) => {
              vtube = v !== false;
              syncMascot();
              if (vtube) drainUnread();
              else void app.commands.execute(VT + "release", {}, { origin: "internal" }).catch(() => {
              });
              notify();
            });
          }
        })
      );
    const advanceCursor = (seq) => {
      if (seq <= cursor) return false;
      cursor = seq;
      void app.data?.kv.set(CURSOR_KEY, seq).catch(() => {
      });
      return true;
    };
    const VTUBE_KEY = "vtube";
    let vtube = true;
    const vtubeOn = () => vtube;
    void app.data?.kv.get(VTUBE_KEY).then((v) => {
      if (v === false) vtube = false;
      notify();
    });
    const NARRATOR_KEY = "narrator";
    const myId = (globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 12);
    let isNarrator = false;
    const claimNarrator = () => {
      isNarrator = true;
      void app.data?.kv.set(NARRATOR_KEY, myId).catch(() => {
      });
    };
    const notify = () => {
      for (const fn of viewListeners) fn();
    };
    const narrate = (e) => {
      if (!vtubeOn() || !cursorReady || !isNarrator) return;
      const text = ttsOf(e, ko);
      if (!text) return;
      if (!advanceCursor(e.seq)) return;
      narrated.add(e.seq);
      void app.commands.execute(VT + "say", { text }, { origin: "internal" }).catch((err) => {
        if (!vtubeWarned) {
          vtubeWarned = true;
          console.warn("[activity] vtube-tts say \uC2E4\uD328 \u2014 \uD14D\uC2A4\uD2B8 \uBAA8\uB4DC\uB85C \uACC4\uC18D:", err);
        }
      });
    };
    const unreadEntries = () => buf.filter((e) => e.seq > cursor && ttsOf(e, ko) !== null);
    const drainUnread = () => {
      if (!vtubeOn() || !cursorReady || !isNarrator) return;
      const u = unreadEntries();
      if (u.length > 3) advanceCursor(u[u.length - 4].seq);
      for (const e of u.slice(-3)) narrate(e);
      notify();
    };
    ctx.subscriptions.push(
      app.events.on("app.focus", (p) => {
        if (p.focused === true) {
          claimNarrator();
          drainUnread();
        }
        notify();
      })
    );
    if (typeof document !== "undefined" && document.hasFocus()) claimNarrator();
    else
      void app.data?.kv.get(NARRATOR_KEY).then((v) => {
        if (v == null) claimNarrator();
        else isNarrator = v === myId;
      });
    const ingest = (e, live) => {
      if (!insertEntry(buf, e)) return;
      if (live) narrate(e);
      notify();
    };
    ctx.subscriptions.push(
      app.events.on("activity", (e) => {
        const { ownWindow, ...entry } = e;
        ingest(entry, true);
      })
    );
    void Promise.resolve(loadCursor).then(
      () => app.commands.execute("activity.recent", { limit: 100 }, { origin: "internal" }).then((r) => {
        const entries = r?.data?.entries ?? r?.entries ?? [];
        for (const e of entries) ingest(e, false);
        const maxSeq = entries.reduce((m, e) => Math.max(m, e.seq), -1);
        if (maxSeq >= 0 && cursor > maxSeq) {
          cursor = maxSeq;
          void app.data?.kv.set(CURSOR_KEY, maxSeq).catch(() => {
          });
        }
        if (maxSeq >= 0) advanceCursor(maxSeq);
      }).catch(() => {
      })
    );
    const syncMascot = () => {
      void app.commands.execute(VT + "mascot.toggle", { on: vtubeOn() }, { origin: "internal" }).catch(() => {
      });
    };
    syncMascot();
    ctx.subscriptions.push(
      app.ui.registerView("log", {
        mount(container, viewCtx) {
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
.al-row.k-chat-prompt .al-text { color:#ffd9a8; font-weight:600; }
.al-row.k-chat-answer .al-text { color:#ffd9a8; }
/* \uB300\uD654 \uC138\uD2B8 \uAD6C\uC131\uC6D0(parentId) \u2014 flat \uB85C\uADF8\uC758 \uB4E4\uC5EC\uC4F0\uAE30 \uB9C8\uCEE4(\uC624\uCF00\uC2A4\uD2B8\uB808\uC774\uD130 \uCE74\uB4DC\uC640 \uAC19\uC740 \uBB36\uC74C). */
.al-row.set { padding-left:14px; border-left:2px solid rgba(255,207,92,.35); }
/* \uC2DC\uC2A4\uD15C \uC720\uB798(\xA75 \u2014 \uC2A4\uCF00\uC904\uB7EC\xB7\uBD80\uD305 \uBD80\uC0B0\uBB3C) \u2014 \uAE30\uB85D\uC740 \uBCF4\uC774\uB418 \uD750\uB9BC. */
.al-row.sys { opacity:.38; }
/* \uBC1C\uD654\uC790 \uBC30\uC9C0(\xA75 R3, \uC624\uCF00\uC2A4\uD2B8\uB808\uC774\uD130 \uB3D9\uD615 \uCE69). */
.al-actor { display:inline-block; margin-left:5px; padding:0 5px; border-radius:7px; font-size:9px; line-height:13px; vertical-align:middle; border:1px solid rgba(255,255,255,.22); background:rgba(255,255,255,.08); }
.al-row.spoken .al-time::after { content:"\u{1F50A}"; margin-left:2px; }
.al-row.unread .al-text { color:#ffe9a8; }
.al-row.unread .al-time::before { content:"\u25CF"; color:#ffcf5c; margin-right:3px; }
.al-empty { color:#8a8a96; padding:12px; text-align:center; }
/* \uC751\uB2F5 \uD45C\uC2DC \uBBF8\uB514\uC5B4 \u2014 \uC774\uBBF8\uC9C0\uB294 \uC774\uBBF8\uC9C0\uB85C(\uC624\uCF00\uC2A4\uD2B8\uB808\uC774\uD130 \uB3D9\uD615, MESSAGE-PROTOCOL media). */
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
            toggle.textContent = vtubeOn() ? ko ? "\uBE0C\uC774\uD29C\uBE0C \uCF2C" : "vtube on" : ko ? "\uBE0C\uC774\uD29C\uBE0C \uB054" : "vtube off";
          };
          toggle.onclick = () => void app.commands.execute("plugin.soksak-plugin-activity.vtube.toggle", {});
          const render = () => {
            renderBar();
            log.replaceChildren();
            if (buf.length === 0) {
              const em = document.createElement("div");
              em.className = "al-empty";
              em.textContent = ko ? "\uC544\uC9C1 \uD65C\uB3D9\uC774 \uC5C6\uC5B4\uC694" : "no activity yet";
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
              const media = mediaOf(e);
              if (media) {
                const img = document.createElement("img");
                img.className = "al-shot";
                img.alt = "";
                if (media.base64) img.src = `data:${media.kind};base64,${media.base64}`;
                else if (media.path && app.fs?.readBinary) {
                  void app.fs.readBinary(media.path).then((f) => {
                    img.src = `data:${f.mime};base64,${f.base64}`;
                  }).catch(() => img.remove());
                }
                log.appendChild(img);
              }
            }
            log.scrollTop = log.scrollHeight;
          };
          const listener = render;
          viewListeners.add(listener);
          render();
          container._alDispose = () => viewListeners.delete(listener);
        },
        unmount(container) {
          container._alDispose?.();
        }
      })
    );
    const reg = (name, spec) => ctx.subscriptions.push(app.commands.register(name, spec));
    reg("ping", {
      description: "Health check \u2014 plugin load/version probe (E2E).",
      triggers: { ko: "\uD65C\uB3D9 \uD50C\uB7EC\uADF8\uC778 \uC0C1\uD0DC \uC810\uAC80 \uD551" },
      handler: () => ({ ok: true, plugin: "soksak-plugin-activity", version: VERSION })
    });
    reg("list", {
      description: "List buffered activity entries (same hub stream the orchestrator shows). narrated marks entries actually spoken.",
      triggers: { ko: "\uD65C\uB3D9 \uB85C\uADF8 \uBAA9\uB85D \uC870\uD68C" },
      params: { limit: { type: "number", description: "max entries (default 20)", required: false } },
      returns: "{ ok, cursor, unreadCount, entries: [{seq, ts, kind, text, tts, narrated, unread}] }",
      handler: (p) => {
        const limit = typeof p.limit === "number" ? Math.max(1, p.limit) : 20;
        return {
          ok: true,
          cursor,
          unreadCount: unreadEntries().length,
          // 진단 — 이 응답을 만든 인스턴스의 시야(창별 상태 어긋남 추적)
          me: { id: myId, narrator: isNarrator, vtube: vtubeOn() },
          entries: buf.slice(-limit).map((e) => ({
            seq: e.seq,
            ts: e.ts,
            kind: e.kind,
            text: lineOf(e),
            tts: ttsOf(e, ko),
            narrated: narrated.has(e.seq),
            unread: e.seq > cursor && ttsOf(e, ko) !== null
          }))
        };
      }
    });
    reg("vtube.toggle", {
      tts: false,
      // 낭독 제어 계열 — 자기 조작 무낭독
      description: "Toggle character narration + mascot (persists via the vtube setting).",
      triggers: { ko: "\uBE0C\uC774\uD29C\uBE0C \uB0AD\uB3C5 \uB9C8\uC2A4\uCF54\uD2B8 \uCF1C\uAE30 \uB044\uAE30" },
      params: { on: { type: "boolean", description: "explicit state; omit to flip", required: false } },
      handler: async (p) => {
        const next = typeof p.on === "boolean" ? p.on : !vtubeOn();
        vtube = next;
        claimNarrator();
        await app.data?.kv.set(VTUBE_KEY, next).catch(() => {
        });
        await app.commands.execute(VT + "mascot.toggle", { on: next }).catch(() => {
        });
        if (next) drainUnread();
        notify();
        return { ok: true, vtube: next };
      }
    });
  }
};
export {
  main_default as default
};
