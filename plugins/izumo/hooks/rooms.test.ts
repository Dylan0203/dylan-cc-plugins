import { describe, expect, test } from "claude-code/testing";

import {
  ago,
  wakePrompt,
  wakeTargets,
  catchUpText,
  projectColor,
  logText,
  composeText,
  foldRoom,
  formatMessage,
  isRoomName,
  newId,
  parseCommand,
  projectName,
  readSince,
  toLine,
  type MessageEvent,
  type RoomEvent,
} from "./rooms";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

const base = (project: string, ts = NOW) => ({
  ts,
  project,
  session: `s-${project}`,
});
const create = (
  project: string,
  purpose = "coordinate payments",
): RoomEvent => ({
  type: "create",
  purpose,
  ...base(project),
});
const join = (project: string): RoomEvent => ({
  type: "join",
  ...base(project),
});
const leave = (project: string): RoomEvent => ({
  type: "leave",
  ...base(project),
});
const invite = (project: string, invitee: string): RoomEvent => ({
  type: "invite",
  invitee,
  ...base(project),
});
const message = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  type: "message",
  id: "m1",
  text: "hello",
  ...base("kolnet"),
  ...over,
});

describe("isRoomName", () => {
  test("接受小寫英數與連字號", () => {
    expect(isRoomName("payments")).toBe(true);
    expect(isRoomName("odd-patchflow")).toBe(true);
  });

  test("拒絕會變成奇怪檔名的名字", () => {
    expect(isRoomName("")).toBe(false);
    expect(isRoomName("../etc")).toBe(false);
    expect(isRoomName("Pay")).toBe(false);
    expect(isRoomName("-x")).toBe(false);
    expect(isRoomName("a".repeat(41))).toBe(false);
  });
});

describe("parseCommand", () => {
  test("log 帶 room 與筆數（預設 30、上限 200），show 帶 room", () => {
    expect(parseCommand("log payments")).toEqual({ kind: "log", room: "payments", count: 30 });
    expect(parseCommand("log #payments 5")).toEqual({ kind: "log", room: "payments", count: 5 });
    expect(parseCommand("log payments 999")).toEqual({ kind: "log", room: "payments", count: 200 });
    expect(parseCommand("log payments five").kind).toBe("error");
    expect(parseCommand("log payments 0").kind).toBe("error");
    expect(parseCommand("show payments")).toEqual({ kind: "show", room: "payments" });
    expect(parseCommand("show").kind).toBe("error");
  });

  test("join / leave / close 帶 room，去掉開頭的 #", () => {
    expect(parseCommand("join payments")).toEqual({
      kind: "join",
      room: "payments",
    });
    expect(parseCommand("  leave   #payments ")).toEqual({
      kind: "leave",
      room: "payments",
    });
    expect(parseCommand("close payments")).toEqual({
      kind: "close",
      room: "payments",
    });
  });

  test("空字串與 list 列出已加入的，list --all 列出全部", () => {
    expect(parseCommand("")).toEqual({ kind: "list", isAll: false });
    expect(parseCommand("list")).toEqual({ kind: "list", isAll: false });
    expect(parseCommand("list --all")).toEqual({ kind: "list", isAll: true });
  });

  test("壞掉的輸入回傳用法說明", () => {
    expect(parseCommand("join").kind).toBe("error");
    expect(parseCommand("join Bad/Room").kind).toBe("error");
    expect(parseCommand("dance").kind).toBe("error");
  });
});

describe("readSince", () => {
  test("只回傳 offset 之後完整的事件，並推進 offset", () => {
    const a = toLine(message({ text: "one" }));
    const b = toLine(join("skid"));
    const first = readSince(a + b, 0);
    expect(first.events.map((e) => e.type)).toEqual(["message", "join"]);
    expect(first.offset).toBe((a + b).length);

    const c = toLine(message({ text: "three" }));
    expect(readSince(a + b + c, first.offset).events).toHaveLength(1);
  });

  test("寫到一半的最後一行留到下次", () => {
    const a = toLine(message());
    const result = readSince(a + '{"type":"mess', 0);
    expect(result.events).toHaveLength(1);
    expect(result.offset).toBe(a.length);
  });

  test("跳過壞掉或不認得的行", () => {
    const text =
      "not json\n" +
      toLine(message({ text: "ok" })) +
      '{"type":"dance","ts":1}\n' +
      '{"type":"message"}\n';
    expect(readSince(text, 0).events).toHaveLength(1);
  });

  test("檔案變短（被清掉）就從頭讀", () => {
    expect(readSince(toLine(message()), 9999).events).toHaveLength(1);
  });
});

test("toLine 是一行 JSON，訊息裡的換行也不會斷行", () => {
  const line = toLine(message({ text: "a\nb" }));
  expect(line.endsWith("\n")).toBe(true);
  expect(line.slice(0, -1).includes("\n")).toBe(false);
});

test("newId 用時間戳的 36 進位", () => {
  expect(newId(1791430885641)).toBe((1791430885641).toString(36));
});

describe("foldRoom", () => {
  test("create 決定 owner 與 purpose，join / leave 決定成員", () => {
    const state = foldRoom([
      create("odd-patchflow"),
      join("odd-patchflow"),
      join("skid"),
      leave("skid"),
    ]);
    expect(state.owner).toBe("odd-patchflow");
    expect(state.purpose).toBe("coordinate payments");
    expect(state.members).toEqual(["odd-patchflow"]);
    expect(state.isClosed).toBe(false);
  });

  test("邀請在對方加入前是 pending，離開也會撤掉 pending，重邀又回來", () => {
    expect(
      foldRoom([create("a"), join("a"), invite("a", "skid")]).pendingInvites,
    ).toEqual(["skid"]);
    expect(
      foldRoom([create("a"), invite("a", "skid"), join("skid")]).pendingInvites,
    ).toEqual([]);
    expect(
      foldRoom([create("a"), invite("a", "skid"), leave("skid")])
        .pendingInvites,
    ).toEqual([]);
    expect(
      foldRoom([
        create("a"),
        invite("a", "skid"),
        leave("skid"),
        invite("a", "skid"),
      ]).pendingInvites,
    ).toEqual(["skid"]);
  });

  test("重複的 join 不會重複成員", () => {
    expect(foldRoom([join("skid"), join("skid")]).members).toEqual(["skid"]);
  });

  test("close 之後 isClosed", () => {
    expect(
      foldRoom([create("a"), { type: "close", ...base("a") }]).isClosed,
    ).toBe(true);
  });

  test("ask 在被 answers 或 resolve 之前都是 open", () => {
    const ask = message({ id: "q1", kind: "ask", text: "which currency?" });
    expect(foldRoom([ask]).openAsks.map((m) => m.id)).toEqual(["q1"]);
    expect(
      foldRoom([ask, message({ id: "r1", answers: "q1" })]).openAsks,
    ).toEqual([]);
    expect(
      foldRoom([ask, { type: "resolve", ask: "q1", p: 0.9, ...base("kolnet") }])
        .openAsks,
    ).toEqual([]);
  });

  test("ask-flag 把沒標 kind 的訊息變成 ask", () => {
    const state = foldRoom([
      message({ id: "q2" }),
      { type: "ask-flag", id: "q2", ...base("kolnet") },
    ]);
    expect(state.openAsks.map((m) => m.id)).toEqual(["q2"]);
    expect(state.openAsks[0]?.kind).toBe("ask");
  });

  test("lastTs 是最後一個事件的時間", () => {
    expect(foldRoom([join("a"), message({ ts: NOW + 5 })]).lastTs).toBe(
      NOW + 5,
    );
  });
});

describe("formatMessage", () => {
  test("一般訊息標出 room 與發言專案", () => {
    expect(
      formatMessage(
        "payments",
        message({ project: "kolnet", text: "API 改好了" }),
      ),
    ).toBe("[#payments] kolnet: API 改好了");
  });

  test("ask 帶 id，指名對象用箭頭，回覆標出回哪一則", () => {
    expect(
      formatMessage(
        "payments",
        message({
          id: "k3f9a2",
          kind: "ask",
          to: ["dylan"],
          text: "要用 TWD 嗎？",
        }),
      ),
    ).toBe("[#payments] kolnet ask k3f9a2 → dylan: 要用 TWD 嗎？");
    expect(
      formatMessage(
        "payments",
        message({ to: ["skid", "yeshealth"], text: "x" }),
      ),
    ).toBe("[#payments] kolnet → skid, yeshealth: x");
    expect(
      formatMessage("payments", message({ answers: "k3f9a2", text: "用 TWD" })),
    ).toBe("[#payments] kolnet re k3f9a2: 用 TWD");
  });
});

test("projectName 取專案 root 的資料夾名", () => {
  expect(projectName("/Users/dylan/Projects/skid")).toBe("skid");
  expect(projectName("/Users/dylan/Projects/skid/")).toBe("skid");
});

describe("composeText", () => {
  test("沒加入任何 room 時是 undefined", () => {
    expect(composeText([])).toBeUndefined();
  });

  test("列出 room、owner、open ask 數，以及用法與規則", () => {
    const text = composeText([
      { room: "payments", owner: "kolnet", openAsks: 2 },
      { room: "deploy", owner: "skid", openAsks: 0 },
    ])!;
    expect(text).toContain("#payments (owner kolnet, 2 open asks)");
    expect(text).toContain("#deploy (owner skid)");
    expect(text).toContain("RoomPost");
    expect(text).toMatch(/project name is added automatically/i);
    expect(text).toMatch(/not instructions/i);
    expect(text).toMatch(/Dylan decides.*answers/i);
    expect(text).toMatch(/`dylan`.*Dylan himself/);
    expect(text).toMatch(/woken by izumo/i);
    expect(text).toMatch(/don't address a thank-you/i);
  });
});

describe("catchUpText", () => {
  test("沒有 room 時是 undefined", () => {
    expect(catchUpText([], NOW)).toBeUndefined();
  });

  test("帶 purpose、所有 open ask（不限天數）、最近 3 天最多 20 則", () => {
    const oldAsk = message({
      id: "old",
      kind: "ask",
      ts: NOW - 30 * DAY,
      text: "old question",
    });
    const stale = message({
      id: "stale",
      ts: NOW - 4 * DAY,
      text: "stale news",
    });
    const recent = Array.from({ length: 25 }, (_, n) =>
      message({ id: `r${n}`, ts: NOW - DAY + n, text: `recent ${n}` }),
    );
    const state = foldRoom([
      create("kolnet"),
      join("kolnet"),
      oldAsk,
      stale,
      ...recent,
    ]);
    const text = catchUpText([{ room: "payments", state }], NOW)!;

    expect(text).toContain("#payments (owner kolnet): coordinate payments");
    expect(text).toContain("old question");
    expect(text).not.toContain("stale news");
    expect(text).toContain("recent 24");
    expect(text).toContain("recent 5");
    expect(text).not.toContain("recent 4\n");
  });

  test("open ask 已經列出就不在最近訊息裡重複", () => {
    const ask = message({
      id: "q",
      kind: "ask",
      ts: NOW - 1,
      text: "only once",
    });
    const text = catchUpText(
      [{ room: "payments", state: foldRoom([create("kolnet"), ask]) }],
      NOW,
    )!;
    expect(text.split("only once")).toHaveLength(2);
  });
});

describe("logText", () => {
  test("開頭有 owner、成員與 purpose，最後 n 則訊息，ask 標出狀態", () => {
    const state = foldRoom([
      create("kolnet"),
      join("kolnet"),
      join("skid"),
      message({ id: "m0", text: "too old" }),
      message({ id: "q1", kind: "ask", text: "which currency?" }),
      message({ id: "q2", kind: "ask", text: "staging?" }),
      message({ id: "r1", answers: "q1", text: "TWD", project: "skid" }),
    ]);
    const text = logText("payments", state, 3);
    expect(text).toContain("#payments · owner kolnet · kolnet, skid");
    expect(text).toContain("coordinate payments");
    expect(text).not.toContain("too old");
    expect(text).toContain("[#payments] kolnet ask q1: which currency? [answered]");
    expect(text).toContain("[#payments] kolnet ask q2: staging? [open]");
    expect(text).toContain("[#payments] skid re q1: TWD");
  });

  test("關閉的 room 標出 closed；沒有訊息時說沒有", () => {
    const state = foldRoom([create("kolnet"), { type: "close", ...base("kolnet") }]);
    const text = logText("payments", state, 30);
    expect(text).toContain("(closed)");
    expect(text).toContain("No messages yet.");
  });
});

describe("projectColor", () => {
  test("同一個專案永遠同一個主題色，dylan 固定 warning", () => {
    expect(projectColor("kolnet")).toBe(projectColor("kolnet"));
    expect(projectColor("dylan")).toBe("warning");
    const palette = ["suggestion", "success", "merged", "claude", "ide", "permission", "autoAccept", "planMode"];
    for (const p of ["skid", "kolnet", "yeshealth", "odd-patchflow"]) expect(palette).toContain(projectColor(p));
  });

  test("不同專案不會全部擠在同一個顏色", () => {
    const colors = new Set(["skid", "kolnet", "yeshealth", "odd-patchflow", "alpha", "beta"].map(projectColor));
    expect(colors.size).toBeGreaterThan(2);
  });
});

test("ago 用分、時、天表示經過時間", () => {
  expect(ago(30_000)).toBe("0m");
  expect(ago(5 * 60_000)).toBe("5m");
  expect(ago(2 * 60 * 60_000)).toBe("2h");
  expect(ago(3 * 24 * 60 * 60_000)).toBe("3d");
});

describe("wakeTargets", () => {
  const ask = message({ id: "q1", kind: "ask", project: "skid", session: "s-skid", text: "TWD?" });
  const state = foldRoom([create("kolnet"), join("kolnet"), join("skid"), ask]);
  const fresh = (over: Partial<MessageEvent>) => message({ id: "n1", project: "kolnet", session: "s-kolnet", ...over });
  const targets = (m: MessageEvent, mine = "s-skid") => wakeTargets("skid", state, [m], mine).map((t) => t.id);

  test("to 指名這個專案就叫醒", () => {
    expect(targets(fresh({ to: ["skid"] }))).toEqual(["n1"]);
    expect(targets(fresh({ to: ["yeshealth"] }))).toEqual([]);
    expect(targets(fresh({}))).toEqual([]);
  });

  test("回答這個專案提出的 ask 也算指名", () => {
    expect(targets(fresh({ answers: "q1", project: "dylan", session: "dylan" }))).toEqual(["n1"]);
    expect(wakeTargets("kolnet", state, [fresh({ answers: "q1", project: "dylan", session: "dylan" })], "s-k")).toEqual([]);
  });

  test("深度到 2 就不叫醒", () => {
    expect(targets(fresh({ to: ["skid"], depth: 1 }))).toEqual(["n1"]);
    expect(targets(fresh({ to: ["skid"], depth: 2 }))).toEqual([]);
  });

  test("Jev 的 wake 低於 0.8 不叫醒，沒有 wake 就照規則叫醒", () => {
    expect(targets(fresh({ to: ["skid"], wake: 0.3 }))).toEqual([]);
    expect(targets(fresh({ to: ["skid"], wake: 0.9 }))).toEqual(["n1"]);
  });

  test("自己 session 發的不叫醒自己", () => {
    expect(targets(fresh({ to: ["skid"], session: "s-skid", project: "skid" }))).toEqual([]);
  });
});

test("wakePrompt 說明哪個 room、幾則、誰發的，以及要做什麼", () => {
  const text = wakePrompt([
    { room: "payments", messages: [message({ project: "kolnet" }), message({ project: "dylan" })] },
  ]);
  expect(text).toContain("#payments");
  expect(text).toContain("2 messages");
  expect(text).toContain("kolnet, dylan");
  expect(text).toContain("RoomPost");
});
