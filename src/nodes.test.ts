// DOM 표면 conformance — C2 투명성 3종의 DOM 축(뷰의 조작 요소는 ui.tree/ui.input.click 로
// 주소지정 가능해야 한다). 뷰를 가진 플러그인은 contributes.nodes 를 선언하고, 그 노드를
// 실제 DOM 요소에 data-node 로 배선한다(선례: soksak-plugin-git-history).
// 검사 축: ① 뷰 보유 → nodes 비어 있지 않음(view-nodes 규칙)
//          ② 선언 ≡ 배선 양방향(plugin.json contributes.nodes ↔ src dataset.node)
//          ③ 배선이 빌드 산출물(main.js)에도 반영 — 실행 번들이 노드를 노출한다
//          ④ 노드 id 는 nodeScan 계약을 따른다(소문자·하이픈, 선택적 /instance)
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(root + "plugin.json", "utf8")) as {
  contributes?: { views?: unknown[]; nodes?: Array<{ id: string; description?: string }> };
};
const src = readFileSync(root + "src/main.ts", "utf8");
const bundle = readFileSync(root + "main.js", "utf8");

const declared = (manifest.contributes?.nodes ?? []).map((n) => n.id);
// dataset.node = "mascot-toggle"  |  dataset.node = `row/${seq}`  — base id(첫 세그먼트)만 수확.
const wired = [...src.matchAll(/dataset\.node\s*=\s*[`"']([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
const NODE_ID = /^[a-z][a-z0-9-]*$/;

describe("C2 DOM 축 — 뷰의 조작 요소는 노드로 노출된다", () => {
  it("뷰 보유 → contributes.nodes 비어 있지 않다 (view-nodes 규칙)", () => {
    expect((manifest.contributes?.views ?? []).length).toBeGreaterThan(0);
    expect(declared.length).toBeGreaterThan(0);
  });

  it("선언 ≡ 배선 — plugin.json nodes ↔ src dataset.node (양방향)", () => {
    expect([...new Set(wired)].sort()).toEqual([...new Set(declared)].sort());
  });

  it("배선이 빌드 산출물(main.js)에도 있다 — 실행 번들이 노드를 노출한다", () => {
    for (const id of declared) expect(bundle).toContain(id);
  });

  it("노드 id 는 nodeScan 계약을 따른다 (소문자·하이픈)", () => {
    for (const id of declared) expect(id).toMatch(NODE_ID);
  });
});
