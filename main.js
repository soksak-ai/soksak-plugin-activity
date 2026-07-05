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
    default:
      return e.kind;
  }
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
          if (key !== CURSOR_KEY) return;
          void app.data.kv.get(CURSOR_KEY).then((v) => {
            if (typeof v === "number" && v > cursor) cursor = v;
          });
        })
      );
    const advanceCursor = (seq) => {
      if (seq <= cursor) return false;
      cursor = seq;
      void app.data?.kv.set(CURSOR_KEY, seq).catch(() => {
      });
      return true;
    };
    const vtubeOn = () => app.settings.get("vtube") !== false;
    let focused = typeof document !== "undefined" ? document.hasFocus() : true;
    const notify = () => {
      for (const fn of viewListeners) fn();
    };
    const narrate = (e) => {
      if (!vtubeOn() || !cursorReady || !focused) return;
      const text = ttsOf(e, ko);
      if (!text) return;
      if (!advanceCursor(e.seq)) return;
      narrated.add(e.seq);
      void app.commands.execute(VT + "say", { text }).catch((err) => {
        if (!vtubeWarned) {
          vtubeWarned = true;
          console.warn("[activity] vtube-tts say \uC2E4\uD328 \u2014 \uD14D\uC2A4\uD2B8 \uBAA8\uB4DC\uB85C \uACC4\uC18D:", err);
        }
      });
    };
    const unreadEntries = () => buf.filter((e) => e.seq > cursor && ttsOf(e, ko) !== null);
    const drainUnread = () => {
      if (!vtubeOn() || !cursorReady || !focused) return;
      for (const e of unreadEntries()) narrate(e);
      notify();
    };
    ctx.subscriptions.push(
      app.events.on("app.focus", (p) => {
        focused = p.focused === true;
        if (focused) drainUnread();
        notify();
      })
    );
    const ingest = (e, live) => {
      if (!insertEntry(buf, e)) return;
      if (live) narrate(e);
      notify();
    };
    ctx.subscriptions.push(
      app.events.on("activity", (e) => {
        const { ownWindow: _own, ...entry } = e;
        ingest(entry, true);
      })
    );
    void Promise.resolve(loadCursor).then(
      () => app.commands.execute("activity.recent", { limit: 100 }).then((r) => {
        const entries = r?.data?.entries ?? r?.entries ?? [];
        for (const e of entries) ingest(e, false);
        const maxSeq = entries.reduce((m, e) => Math.max(m, e.seq), -1);
        if (maxSeq >= 0) advanceCursor(maxSeq);
      }).catch(() => {
      })
    );
    const syncMascot = () => {
      void app.commands.execute(VT + "mascot.toggle", { on: vtubeOn() }).catch(() => {
      });
    };
    ctx.subscriptions.push(app.settings.onChange(() => {
      syncMascot();
      drainUnread();
      notify();
    }));
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
.al-row.spoken .al-time::after { content:"\u{1F50A}"; margin-left:2px; }
.al-row.unread .al-text { color:#ffe9a8; }
.al-row.unread .al-time::before { content:"\u25CF"; color:#ffcf5c; margin-right:3px; }
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
              row.className = `al-row k-${e.kind.split(".").join("-")}${narrated.has(e.seq) ? " spoken" : ""}${unreadSet.has(e.seq) ? " unread" : ""}`;
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
      description: "Toggle character narration + mascot (persists via the vtube setting).",
      triggers: { ko: "\uBE0C\uC774\uD29C\uBE0C \uB0AD\uB3C5 \uB9C8\uC2A4\uCF54\uD2B8 \uCF1C\uAE30 \uB044\uAE30" },
      params: { on: { type: "boolean", description: "explicit state; omit to flip", required: false } },
      handler: async (p) => {
        const next = typeof p.on === "boolean" ? p.on : !vtubeOn();
        await app.commands.execute("plugin.settings.set", {
          id: "soksak-plugin-activity",
          key: "vtube",
          value: next
        });
        return { ok: true, vtube: next };
      }
    });
  }
};
export {
  main_default as default
};
