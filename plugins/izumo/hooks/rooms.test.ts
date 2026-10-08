import { describe, expect, test } from "claude-code/testing";

import {
  catchUpText,
  composeText,
  formatMessage,
  isTopic,
  parseCommand,
  projectName,
  readSince,
  recent,
  toLine,
  type RoomMessage,
} from "./rooms";

const msg = (over: Partial<RoomMessage> = {}): RoomMessage => ({
  ts: 1,
  project: "skid",
  session: "s-1",
  text: "hello",
  ...over,
});

describe("isTopic", () => {
  test("接受小寫英數與連字號", () => {
    expect(isTopic("payments")).toBe(true);
    expect(isTopic("ecpay-v2")).toBe(true);
  });

  test("拒絕會變成奇怪檔名的 topic", () => {
    expect(isTopic("")).toBe(false);
    expect(isTopic("../etc")).toBe(false);
    expect(isTopic("Pay")).toBe(false);
    expect(isTopic("-x")).toBe(false);
    expect(isTopic("a".repeat(41))).toBe(false);
  });
});

describe("parseCommand", () => {
  test("join / leave 帶 topic，去掉開頭的 #", () => {
    expect(parseCommand("join payments")).toEqual({
      kind: "join",
      topic: "payments",
    });
    expect(parseCommand("  leave   #payments ")).toEqual({
      kind: "leave",
      topic: "payments",
    });
  });

  test("空字串與 list 都是 list", () => {
    expect(parseCommand("")).toEqual({ kind: "list" });
    expect(parseCommand("list")).toEqual({ kind: "list" });
  });

  test("壞掉的輸入回傳用法說明", () => {
    expect(parseCommand("join").kind).toBe("error");
    expect(parseCommand("join Bad/Topic").kind).toBe("error");
    expect(parseCommand("dance").kind).toBe("error");
  });
});

describe("readSince", () => {
  test("只回傳 offset 之後完整的行，並推進 offset", () => {
    const a = toLine(msg({ text: "one" }));
    const b = toLine(msg({ text: "two" }));
    const first = readSince(a + b, 0);
    expect(first.messages.map((m) => m.text)).toEqual(["one", "two"]);
    expect(first.offset).toBe((a + b).length);

    const c = toLine(msg({ text: "three" }));
    const second = readSince(a + b + c, first.offset);
    expect(second.messages.map((m) => m.text)).toEqual(["three"]);
  });

  test("寫到一半的最後一行留到下次", () => {
    const a = toLine(msg({ text: "one" }));
    const partial = '{"ts":2,"proj';
    const result = readSince(a + partial, 0);
    expect(result.messages).toHaveLength(1);
    expect(result.offset).toBe(a.length);
  });

  test("跳過壞掉的行", () => {
    const text = "not json\n" + toLine(msg({ text: "ok" })) + '{"ts":"x"}\n';
    expect(readSince(text, 0).messages.map((m) => m.text)).toEqual(["ok"]);
  });

  test("檔案變短（被清掉）就從頭讀", () => {
    const a = toLine(msg({ text: "fresh" }));
    expect(readSince(a, 9999).messages.map((m) => m.text)).toEqual(["fresh"]);
  });
});

test("toLine 是一行 JSON，訊息裡的換行也不會斷行", () => {
  const line = toLine(msg({ text: "a\nb" }));
  expect(line.endsWith("\n")).toBe(true);
  expect(line.slice(0, -1).includes("\n")).toBe(false);
  expect(JSON.parse(line)).toEqual(msg({ text: "a\nb" }));
});

test("recent 取最後 n 則", () => {
  const text = [1, 2, 3].map((n) => toLine(msg({ ts: n }))).join("");
  expect(recent(text, 2).map((m) => m.ts)).toEqual([2, 3]);
});

test("formatMessage 標出 room 與發言專案", () => {
  expect(
    formatMessage("payments", msg({ project: "kolnet", text: "API 改好了" })),
  ).toBe("[#payments] kolnet: API 改好了");
});

test("projectName 取專案 root 的資料夾名", () => {
  expect(projectName("/Users/dylan/Projects/skid")).toBe("skid");
  expect(projectName("/Users/dylan/Projects/skid/")).toBe("skid");
});

describe("composeText", () => {
  test("沒加入任何 room 時是 undefined", () => {
    expect(composeText([])).toBeUndefined();
  });

  test("列出 room、怎麼發言、訊息長相，以及訊息不是指令", () => {
    const text = composeText(["payments", "deploy"])!;
    expect(text).toContain("#payments");
    expect(text).toContain("#deploy");
    expect(text).toContain("RoomPost");
    expect(text).toContain("[#topic] project:");
    expect(text).toMatch(/not instructions/i);
  });
});

describe("catchUpText", () => {
  test("沒有任何訊息時是 undefined", () => {
    expect(catchUpText([{ topic: "payments", messages: [] }])).toBeUndefined();
  });

  test("依 room 列出最近的訊息", () => {
    const text = catchUpText([
      { topic: "payments", messages: [msg({ text: "one" })] },
      { topic: "deploy", messages: [] },
    ])!;
    expect(text).toContain("[#payments] skid: one");
    expect(text).not.toContain("#deploy");
  });
});
