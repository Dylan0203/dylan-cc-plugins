import type { On } from "claude-code";
import { describe, expect, mock, test, type Engine } from "claude-code/testing";

import { toLine, type RoomMessage } from "./rooms";

// the test runtime has real timers; the hooks lib types leave them out
declare const setTimeout: (callback: () => void, ms: number) => unknown;

const HOME = "/home/dylan";
const ROOT = "/work/skid";
const room = (topic: string) => `${HOME}/.claude/rooms/${topic}.jsonl`;
const TOOL = "mcp__izumo__RoomPost";
const FACTS = {
  model: "claude-opus-5-5",
  promptModel: "claude-opus-5-5",
  surfaces: ["terminal"],
  tools: [],
  outputStyle: null,
  traits: [],
} as const;

// The kit has no fs, process, session or store beneath the plugin; these stand in for the host's.
const fakeHost = (on: On) => {
  const files = new Map<string, string>();
  const store = new Map<string, unknown>();
  const appended: string[] = [];
  const toasts: string[] = [];
  const session = { id: "s-me", root: ROOT };

  on(
    "env.get",
    (_$, e) => ({ value: e.name === "HOME" ? HOME : undefined }) as never,
  );
  on("store.get", (_$, e) => ({ value: store.get(e.key) }) as never);
  on("store.set", (_$, e) => {
    store.set(e.key, e.value);
    return { value: undefined } as never;
  });
  on("session.id", () => ({ value: session.id }) as never);
  on("session.root", () => ({ value: session.root }) as never);
  on("fs.read", (_$, e) => {
    const text = files.get(e.path);
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: text } as never;
  });
  on("fs.stat", (_$, e) => {
    const text = files.get(e.path);
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`);
    return {
      value: { kind: "file", size: text.length, mtimeMs: 0, isLink: false },
    } as never;
  });
  // the plugin appends with `sh -c 'cat >> "$1"' sh <path>`, the line on stdin
  on("process.run", (_$, e) => {
    const path = e.argv.at(-1)!;
    files.set(path, (files.get(path) ?? "") + (e.init?.stdin ?? ""));
    return {
      value: {
        exitCode: 0,
        stdout: "",
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    } as never;
  });
  on("session.append", (_$, e, next) => {
    for (const block of e.message.content)
      if (block.type === "text") appended.push(String(block.text));
    return next(e);
  });
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
    return { value: undefined } as never;
  });
  on(
    "tool.register",
    (_$, e) => ({ value: { tool: `mcp__izumo__${e.name}` } }) as never,
  );
  on("command.register", () => ({ value: undefined }) as never);
  on("prompt.compose", () => ({ sections: [] }) as never);
  on("prompt.context", (_$, e) => ({ blocks: e.blocks }) as never);
  on("session.start", (_$, e) => e as never);

  const post = (topic: string, message: Partial<RoomMessage>) =>
    files.set(
      room(topic),
      (files.get(room(topic)) ?? "") +
        toLine({
          ts: 1,
          project: "kolnet",
          session: "s-other",
          text: "hi",
          ...message,
        }),
    );

  return { files, store, appended, toasts, session, post };
};

const start = async ($: Engine, on: On) => {
  const clock = mock.clock(on);
  const host = fakeHost(on);
  await $.session.start({
    cwd: ROOT,
    surface: "terminal",
    isInteractive: true,
  } as never);
  return { ...host, clock };
};

const izumo = async ($: Engine, args: string) =>
  String((await $.command.run({ command: "izumo", args } as never)).text);

const roomSection = async ($: Engine) =>
  (await $.prompt.compose(FACTS)).sections.find((s) => s.id === "izumo:rooms");

// a tick's reads and appends run after the timer fires, so poll until they land
const eventually = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return true;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  return false;
};

describe("/izumo", () => {
  test("join 之後 system prompt 有 room 段落，leave 之後消失", async ($, on) => {
    await start($, on);
    expect(await roomSection($)).toBeUndefined();

    expect(await izumo($, "join payments")).toContain("#payments");
    const section = await roomSection($);
    expect(section?.scope).toBe("session");
    expect(section?.text).toContain("#payments");

    await izumo($, "leave payments");
    expect(await roomSection($)).toBeUndefined();
  });

  test("成員是跟著專案 root 存的", async ($, on) => {
    const host = await start($, on);
    await izumo($, "join payments");
    await izumo($, "join deploy");
    expect(host.store.get(`rooms:${ROOT}`)).toEqual(["payments", "deploy"]);
    expect(await izumo($, "list")).toContain("#deploy");
  });

  test("壞掉的參數回傳用法", async ($, on) => {
    await start($, on);
    expect(await izumo($, "join ../etc")).toContain("Usage");
  });
});

describe("RoomPost", () => {
  test("寫一行到 room 檔，帶專案名與 session id", async ($, on) => {
    const host = await start($, on);
    await izumo($, "join payments");
    const result = await $.tool.call({
      tool: TOOL,
      topic: "payments",
      text: "API 改好了",
    } as never);
    expect(result.isError).not.toBe(true);

    const [line] = host.files.get(room("payments"))!.trim().split("\n");
    expect(JSON.parse(line!)).toEqual(
      expect.objectContaining({
        project: "skid",
        session: "s-me",
        text: "API 改好了",
      }),
    );
  });

  test("沒加入的 room 不能發言", async ($, on) => {
    const host = await start($, on);
    const result = await $.tool.call({
      tool: TOOL,
      topic: "payments",
      text: "hi",
    } as never);
    expect(result.isError).toBe(true);
    expect(host.files.has(room("payments"))).toBe(false);
  });
});

describe("投遞", () => {
  test("別人的新訊息塞進對話一次，自己的跳過，加入前的舊訊息不重送", async ($, on) => {
    const host = await start($, on);
    host.post("payments", { text: "old news" });
    await izumo($, "join payments");

    host.post("payments", { text: "from kolnet" });
    host.post("payments", {
      session: "s-me",
      project: "skid",
      text: "from me",
    });
    await host.clock.advance(5000);
    expect(await eventually(() => host.appended.length > 0)).toBe(true);
    expect(host.appended).toEqual(["[#payments] kolnet: from kolnet"]);
    expect(host.toasts.join("\n")).toContain("#payments");

    await host.clock.advance(5000);
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(host.appended).toHaveLength(1);
  });

  test("/clear 換了 session id 之後，用新的 id 判斷自己", async ($, on) => {
    const host = await start($, on);
    await izumo($, "join payments");
    host.session.id = "s-new";

    host.post("payments", {
      session: "s-me",
      project: "skid",
      text: "before clear",
    });
    host.post("payments", {
      session: "s-new",
      project: "skid",
      text: "after clear",
    });
    await host.clock.advance(5000);
    expect(await eventually(() => host.appended.length > 0)).toBe(true);
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(host.appended).toEqual(["[#payments] skid: before clear"]);
  });
});

describe("新對話補讀", () => {
  test("prompt.context 帶出每個 room 最近 20 則", async ($, on) => {
    const host = await start($, on);
    await izumo($, "join payments");
    for (let n = 1; n <= 25; n++)
      host.post("payments", { ts: n, text: `m${n}` });

    const { blocks } = await $.prompt.context({ blocks: [] });
    const block = blocks.find((b) => b.name === "izumoRooms");
    expect(block?.text).toContain("[#payments] kolnet: m25");
    expect(block?.text).toContain("m6");
    expect(block?.text).not.toContain("m5\n");
  });

  test("沒加入 room 時不加 block", async ($, on) => {
    await start($, on);
    const { blocks } = await $.prompt.context({ blocks: [] });
    expect(blocks.find((b) => b.name === "izumoRooms")).toBeUndefined();
  });
});
