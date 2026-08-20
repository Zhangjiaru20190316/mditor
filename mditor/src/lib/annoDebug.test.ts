import { afterEach, describe, expect, it } from "vitest";
import {
  annoCount,
  annoCounters,
  annoDebugClear,
  annoEmit,
  annoEvents,
  annoSubscribe,
  registerAnnoProbe,
  registerPmObserverGate,
  runAnnoHealthCheck,
  withPmObserverPaused,
  type AnnoEditorProbe,
} from "./annoDebug";
import { buildDefinition } from "./annotations";

function resetDebug() {
  annoDebugClear();
  registerAnnoProbe(null);
  registerPmObserverGate(null);
}
afterEach(resetDebug);

describe("annoDebug event bus", () => {
  it("counts and buffers events, capacity-capped", () => {
    annoCount("a.b", 2);
    annoEmit("x.y", "hello", { data: { id: "anno-1" } });
    expect(annoCounters()).toEqual({ "a.b": 2, "x.y": 1 });
    expect(annoEvents()).toHaveLength(1);
    expect(annoEvents()[0].msg).toBe("hello");
    for (let i = 0; i < 400; i++) annoEmit("bulk", `e${i}`);
    expect(annoEvents().length).toBeLessThanOrEqual(300);
    expect(annoEvents().at(-1)?.msg).toBe("e399");
  });

  it("notifies subscribers and drops throwing ones", () => {
    let got = 0;
    const bad = () => {
      throw new Error("boom");
    };
    annoSubscribe(bad);
    const good = () => got++;
    const unsub = annoSubscribe(good);
    annoEmit("k", "m");
    expect(got).toBe(1);
    unsub();
    annoEmit("k", "m");
    expect(got).toBe(1);
  });
});

describe("withPmObserverPaused", () => {
  it("runs fn directly when no gate registered (graceful degradation)", () => {
    let ran = false;
    withPmObserverPaused(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("wraps fn in stop/start, and a throwing gate falls back to direct run", () => {
    const calls: string[] = [];
    registerPmObserverGate((fn) => {
      calls.push("gate");
      fn();
    });
    let ran = false;
    withPmObserverPaused(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(calls).toEqual(["gate"]);

    registerPmObserverGate(() => {
      throw new Error("gate broken");
    });
    ran = false;
    withPmObserverPaused(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe("runAnnoHealthCheck", () => {
  const md = [
    "# t",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "[^anno-1]",
    "",
    '[^anno-1]: 单行批注',
  ].join("\n");
  const multiLineMd = md.replace(
    "[^anno-1]: 单行批注",
    "[^anno-1]: 首行\n    - 项目一\n    - 项目二"
  );

  it("reports n/a across editor-dependent columns without a probe", () => {
    const rows = runAnnoHealthCheck(md);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.id).toBe("anno-1");
    expect(r.defInMd).toBe(true);
    expect(r.defInDoc).toBe("n/a");
    expect(r.standaloneParse).toBe("n/a");
    expect(r.roundTrip).toBe("n/a");
  });

  it("flags a definition the real parser drops (probe hasDefInDoc=false)", () => {
    const probe: AnnoEditorProbe = {
      hasDefInDoc: () => false,
      parseStandalone: () => true,
      serializeDef: () => null,
    };
    registerAnnoProbe(probe);
    const rows = runAnnoHealthCheck(md);
    expect(rows[0].defInDoc).toBe("fail");
    expect(rows[0].notes.join()).toContain("no-def");
  });

  it("flags buildDefinition forms the real parser cannot parse standalone", () => {
    const probe: AnnoEditorProbe = {
      hasDefInDoc: () => true,
      parseStandalone: (text) => !text.includes("项目"),
      serializeDef: () => buildDefinition("anno-1", "单行批注"),
    };
    registerAnnoProbe(probe);
    const rows = runAnnoHealthCheck(multiLineMd);
    expect(rows[0].standaloneParse).toBe("fail");
    expect(rows[0].notes.join()).toContain("no-parse");
  });

  it("detects serialize round-trip content loss", () => {
    const probe: AnnoEditorProbe = {
      hasDefInDoc: () => true,
      parseStandalone: () => true,
      // 序列化只回了首行——多行体被截断。
      serializeDef: (id) => `[^${id}]: 首行`,
    };
    registerAnnoProbe(probe);
    const rows = runAnnoHealthCheck(multiLineMd);
    expect(rows[0].roundTrip).toBe("fail");
    expect(rows[0].notes.join()).toContain("往返");
  });

  it("passes a fully healthy annotation", () => {
    const probe: AnnoEditorProbe = {
      hasDefInDoc: () => true,
      parseStandalone: () => true,
      serializeDef: (id) => `[^${id}]: 首行\n    - 项目一\n    - 项目二`,
    };
    registerAnnoProbe(probe);
    const rows = runAnnoHealthCheck(multiLineMd);
    const r = rows[0];
    expect([r.defInDoc, r.standaloneParse, r.roundTrip]).toEqual([
      "pass",
      "pass",
      "pass",
    ]);
    expect(r.notes).toHaveLength(0);
  });
});
