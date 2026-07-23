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
  if (typeof p.durationMs === "number") {
    const head = `${p.command} ${p.ok ? "\u2713" : `\u2717 ${p.code ?? ""}`} (${p.durationMs}ms)`;
    return p.message ? `${head} \u2192 ${p.message}` : head;
  }
  return typeof p.message === "string" && p.message ? p.message : e.kind;
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
function speakOf(e) {
  const own = e.payload.speak;
  return typeof own === "string" && own.trim() ? own.trim() : null;
}

// src/main.ts
var NARRATION_CONTRACT = "soksak-spec-plugin-narration";
function narratorIdOf(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.id === "string") return v.id;
  return null;
}
function narratorWindowOf(v) {
  if (v && typeof v === "object" && typeof v.window === "string")
    return v.window;
  return null;
}
var VERSION = "1.0.0";
var main_default = {
  activate(ctx) {
    const app = ctx.app;
    const ko = (app.locale?.() ?? "ko").startsWith("ko");
    const buf = [];
    const narrated = /* @__PURE__ */ new Set();
    const viewListeners = /* @__PURE__ */ new Set();
    let mascotWarned = false;
    let narratorEngine = null;
    const resolveEngine = async () => {
      if (narratorEngine) return narratorEngine;
      try {
        const out = await app.commands.execute("plugin.implementers", { id: NARRATION_CONTRACT });
        const found = (out?.data?.implementers || []).find((i) => i.status === "enabled");
        narratorEngine = found ? found.id : null;
      } catch {
        narratorEngine = null;
      }
      return narratorEngine;
    };
    const narration = (verb, params = {}, onFail) => {
      void resolveEngine().then((id) => {
        if (!id) return;
        void app.commands.execute(`plugin.${id}.${verb}`, params, { origin: "internal" }).catch((err) => {
          narratorEngine = null;
          onFail?.(err);
        });
      });
    };
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
              isNarrator = narratorIdOf(v) === myId;
              if (was && !isNarrator) narration("release");
              if (was !== isNarrator) syncMascot();
            });
          } else if (key === MASCOT_KEY) {
            void app.data.kv.get(MASCOT_KEY).then((v) => {
              mascot = v !== false;
              syncMascot();
              if (mascot) drainUnread();
              else narration("release");
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
    const MASCOT_KEY = "mascot";
    let mascot = true;
    const mascotOn = () => mascot;
    void app.data?.kv.get(MASCOT_KEY).then((v) => {
      if (v === false) mascot = false;
      notify();
    });
    const NARRATOR_KEY = "narrator";
    const myId = (globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 12);
    let isNarrator = false;
    const claimNarrator = () => {
      const was = isNarrator;
      isNarrator = true;
      void app.data?.kv.set(NARRATOR_KEY, { id: myId, window: app.windowLabel?.() ?? "" }).catch(() => {
      });
      if (!was) syncMascot();
    };
    const notify = () => {
      for (const l of viewListeners) l.refresh();
    };
    const notifyAppend = (e) => {
      for (const l of viewListeners) l.append(e);
    };
    const narrate = (e) => {
      if (!mascotOn() || !cursorReady || !isNarrator) return;
      const text = speakOf(e);
      if (!text) return;
      if (!advanceCursor(e.seq)) return;
      narrated.add(e.seq);
      narration("say", { text }, (err) => {
        if (!mascotWarned) {
          mascotWarned = true;
          console.warn("[activity] narration say \uC2E4\uD328 \u2014 \uD14D\uC2A4\uD2B8 \uBAA8\uB4DC\uB85C \uACC4\uC18D:", err);
        }
      });
    };
    const unreadEntries = () => buf.filter((e) => e.seq > cursor && speakOf(e) !== null);
    const drainUnread = () => {
      if (!mascotOn() || !cursorReady || !isNarrator) return;
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
      void app.data?.kv.get(NARRATOR_KEY).then(async (v) => {
        if (v == null) return claimNarrator();
        isNarrator = narratorIdOf(v) === myId;
        if (isNarrator) return;
        const w = narratorWindowOf(v);
        if (w === null) return claimNarrator();
        try {
          const r = await app.commands.execute("window.list", {}, { origin: "internal" });
          const labels = (r?.data?.labels ?? r?.labels ?? []) || [];
          if (!labels.includes(w)) claimNarrator();
        } catch {
        }
      });
    const ingest = (e, live) => {
      if (!insertEntry(buf, e)) return;
      if (live) narrate(e);
      if (live && buf[buf.length - 1] === e) notifyAppend(e);
      else notify();
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
      narration("toggle", { on: mascotOn() && isNarrator });
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
.al-bar { display:flex; gap:6px; height:var(--toolbar-h,28px); padding:0 var(--toolbar-pad-x,8px); border-bottom:1px solid rgba(255,255,255,.08); align-items:center; }
.al-btn { padding:3px 9px; border-radius:7px; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.08); color:inherit; cursor:pointer; font:inherit; font-size:11px; }
.al-log { flex:1; overflow-y:auto; padding:6px 8px; display:flex; flex-direction:column; gap:3px; }
/* \uC2A4\uD06C\uB864\uBC14 \u2014 \uCF54\uC5B4 \uC815\uBCF8(App.css 4px)\uACFC \uB3D9\uC77C: \uD50C\uB7EC\uADF8\uC778 \uBDF0(Shadow DOM)\uC5D4 \uC804\uC5ED \uADDC\uCE59\uC774 \uC548 \uB4E4\uC5B4\uC628\uB2E4. */
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
          toggle.dataset.node = "mascot-toggle";
          bar.appendChild(toggle);
          const log = document.createElement("div");
          log.className = "al-log";
          root.append(bar, log);
          const renderBar = () => {
            toggle.textContent = mascotOn() ? ko ? "\uBE0C\uC774\uD29C\uBE0C \uCF2C" : "mascot on" : ko ? "\uBE0C\uC774\uD29C\uBE0C \uB054" : "mascot off";
          };
          toggle.onclick = () => void app.commands.execute("plugin.soksak-plugin-activity.mascot.toggle", {});
          const renderRow = (e, unreadSet) => {
            const frag = document.createDocumentFragment();
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
            frag.appendChild(row);
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
              frag.appendChild(img);
            }
            return frag;
          };
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
            for (const e of buf) log.appendChild(renderRow(e, unreadSet));
            log.scrollTop = log.scrollHeight;
          };
          const listener = {
            refresh: render,
            append: (e) => {
              if (buf.length === 1) return render();
              const unreadSet = new Set(unreadEntries().map((x) => x.seq));
              viewCtx.setBadge?.(unreadSet.size > 0 ? unreadSet.size : null);
              log.appendChild(renderRow(e, unreadSet));
              while (log.children.length > 0 && log.children.length > buf.length * 2) log.firstChild.remove();
              log.scrollTop = log.scrollHeight;
            }
          };
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
      message: (d) => `\uD65C\uB3D9 \uD50C\uB7EC\uADF8\uC778 v${d.version}\uC774 \uC0B4\uC544\uC788\uC2B5\uB2C8\uB2E4.`,
      handler: () => ({ ok: true, plugin: "soksak-plugin-activity", version: VERSION })
    });
    reg("list", {
      description: "List buffered activity entries (same hub stream the orchestrator shows). narrated marks entries actually spoken.",
      triggers: { ko: "\uD65C\uB3D9 \uB85C\uADF8 \uBAA9\uB85D \uC870\uD68C" },
      params: { limit: { type: "number", description: "max entries (default 20)", required: false } },
      returns: "{ ok, cursor, unreadCount, entries: [{seq, ts, kind, text, speak, narrated, unread}] }",
      message: (d) => `\uD65C\uB3D9 ${(d.entries ?? []).length}\uAC1C (\uC548 \uC77D\uC74C ${d.unreadCount ?? 0}\uAC1C).`,
      // 낭독이 꺼져있고 밀린 항목이 있을 때만 제시 — 이미 듣고 있으면 불필요한 제안이다.
      hint: (d) => {
        const unreadCount = typeof d.unreadCount === "number" ? d.unreadCount : 0;
        const me = d.me;
        if (unreadCount > 0 && me?.mascot === false) {
          return [
            {
              cmd: "plugin.soksak-plugin-activity.mascot.toggle",
              why: "\uB0AD\uB3C5\uC744 \uCF1C\uBA74 \uBC00\uB9B0 \uD65C\uB3D9\uC744 \uB4E4\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4"
            }
          ];
        }
        return [];
      },
      handler: (p) => {
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
            speak: speakOf(e),
            narrated: narrated.has(e.seq),
            unread: e.seq > cursor && speakOf(e) !== null
          }))
        };
      }
    });
    reg("mascot.toggle", {
      speak: () => "",
      // 낭독 제어 계열 — 자기 조작 무낭독(§3)
      description: "Toggle character narration + mascot (persists via the mascot setting).",
      triggers: { ko: "\uBE0C\uC774\uD29C\uBE0C \uB0AD\uB3C5 \uB9C8\uC2A4\uCF54\uD2B8 \uCF1C\uAE30 \uB044\uAE30" },
      message: (d) => d.mascot ? "\uB0AD\uB3C5\uC744 \uCF30\uC2B5\uB2C8\uB2E4." : "\uB0AD\uB3C5\uC744 \uAED0\uC2B5\uB2C8\uB2E4.",
      params: { on: { type: "boolean", description: "explicit state; omit to flip", required: false } },
      // 켬 직후에만 제시 — 지금부터 무엇이 읽힐지 list 로 확인할 수 있다. 끔은 후속이 없다.
      hint: (d) => d.mascot ? [
        {
          cmd: "plugin.soksak-plugin-activity.list",
          why: "\uC9C0\uAE08\uAE4C\uC9C0\uC758 \uD65C\uB3D9 \uB85C\uADF8\uB97C \uD655\uC778\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4"
        }
      ] : [],
      handler: async (p) => {
        const next = typeof p.on === "boolean" ? p.on : !mascotOn();
        mascot = next;
        claimNarrator();
        await app.data?.kv.set(MASCOT_KEY, next).catch(() => {
        });
        narration("toggle", { on: next });
        if (next) drainUnread();
        notify();
        return { ok: true, mascot: next };
      }
    });
  }
};
export {
  main_default as default
};
