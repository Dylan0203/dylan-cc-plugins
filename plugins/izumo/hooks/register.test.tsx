import type { On } from "claude-code";
import { describe, expect, mock, test, type Engine } from "claude-code/testing";

import { foldRoom, parseEvents, projectColor, toLine, type RoomEvent } from "./rooms";

// the test runtime has real timers; the hooks lib types leave them out
declare const setTimeout: (callback: () => void, ms: number) => unknown;

const HOME = "/home/dylan";
const ROOT = "/work/skid";
const DIR = `${HOME}/.claude/rooms`;
const file = (room: string) => `${DIR}/${room}.jsonl`;
const FACTS = {
  model: "claude-opus-5-5",
  promptModel: "claude-opus-5-5",
  surfaces: ["terminal"],
  tools: [],
  outputStyle: null,
  traits: [],
} as const;

// The kit has no fs, process or session beneath the plugin; these stand in for the host's.
// There is deliberately no store: izumo keeps everything in the room files.
const fakeHost = (on: On) => {
  const files = new Map<string, string>();
  const appended: string[] = [];
  const toasts: string[] = [];
  const session = { id: "s-me", root: ROOT };
  // real milliseconds each fs.read takes, so a test can make a poll outlast the next tick
  const slow = { readMs: 0 };

  const env: Record<string, string> = { HOME };
  // what Jev answers: each request's parsed body in, the answers map out (undefined = HTTP 500)
  const jev = {
    calls: [] as { questions: Record<string, { instructions: string }> }[],
    answer: (_body: unknown): Record<string, { type: string; noul: number }> | undefined => ({}),
  };

  on("env.get", (_$, e) => ({ value: env[e.name] }) as never);
  on("http.fetch", (_$, e) => {
    const body = JSON.parse(String(e.init?.body));
    jev.calls.push(body);
    const answers = jev.answer(body);
    return {
      value: {
        status: answers ? 200 : 500,
        ok: answers !== undefined,
        headers: {},
        text: JSON.stringify({ answers }),
      },
    } as never;
  });
  on("session.id", () => ({ value: session.id }) as never);
  on("session.root", () => ({ value: session.root }) as never);
  on("fs.list", (_$, e) => {
    if (e.path !== DIR) throw new Error(`ENOENT: ${e.path}`);
    const entries = [...files]
      .filter(([path]) => path.startsWith(`${DIR}/`))
      .map(([path, text]) => ({
        name: path.slice(DIR.length + 1),
        kind: "file",
        size: text.length,
        mtimeMs: 0,
        isLink: false,
      }));
    return { value: entries } as never;
  });
  on("fs.read", async (_$, e) => {
    if (slow.readMs) await new Promise<void>((r) => setTimeout(r, slow.readMs));
    const text = files.get(e.path);
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: text } as never;
  });
  // the plugin appends with `sh -c 'cat >> "$1"' sh <path>`, the line on stdin; mkdir is a no-op here
  on("process.run", (_$, e) => {
    if (e.argv[0] === "sh") {
      const path = e.argv.at(-1)!;
      files.set(path, (files.get(path) ?? "") + (e.init?.stdin ?? ""));
    }
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
  const opened: string[] = [];
  on("ui.open", (_$, e) => {
    opened.push(`${e.id}${e.focus ? " (focus)" : ""}`);
    return { value: { isPlaced: true } } as never;
  });
  on("prompt.compose", () => ({ sections: [] }) as never);
  on("prompt.context", (_$, e) => ({ blocks: e.blocks }) as never);
  on("session.start", (_$, e) => e as never);
  // the transcript as $.session.messages() reads it: izumo's own rows included
  const transcript: string[] = [];
  on("session.messages", () => ({ value: transcript.map((text) => ({ role: "user", text, toolUses: [] })) }) as never);
  on("classic.SessionStart", () => ({}) as never);

  const write = (room: string, event: RoomEvent) =>
    files.set(file(room), (files.get(file(room)) ?? "") + toLine(event));
  const events = (room: string) => parseEvents(files.get(file(room)) ?? "");
  const state = (room: string) => foldRoom(events(room));
  // a room kolnet owns, with skid already in it
  const seedRoom = (room: string, members = ["kolnet", "skid"]) => {
    write(room, {
      type: "create",
      purpose: "coordinate payments",
      ts: 1,
      project: "kolnet",
      session: "s-k",
    });
    for (const project of members)
      write(room, { type: "join", ts: 1, project, session: `s-${project}` });
  };
  const say = (room: string, text: string, over: Partial<RoomEvent> = {}) =>
    write(room, {
      type: "message",
      id: `id-${text}`,
      text,
      ts: 2,
      project: "kolnet",
      session: "s-other",
      ...over,
    } as RoomEvent);

  return {
    files,
    appended,
    toasts,
    session,
    slow,
    write,
    events,
    state,
    seedRoom,
    say,
    env,
    jev,
    transcript,
    opened,
  };
};

const start = async ($: Engine, on: On) => {
  const clock = mock.clock(on, { now: 1000 });
  const host = fakeHost(on);
  return { ...host, clock };
};
const boot = async ($: Engine) =>
  $.session.start({
    cwd: ROOT,
    surface: "terminal",
    isInteractive: true,
  } as never);

const izumo = async ($: Engine, args: string) =>
  String((await $.command.run({ command: "izumo", args } as never)).text);
const tool = ($: Engine, name: string, input: Record<string, unknown>) =>
  $.tool.call({ tool: `mcp__izumo__${name}`, ...input } as never);
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
const settle = () => new Promise<void>((r) => setTimeout(r, 30));

describe("RoomCreate", () => {
  test("沒給名字就用專案名，寫入 create、join 與邀請", async ($, on) => {
    const host = await start($, on);
    await boot($);
    const result = await tool($, "RoomCreate", {
      purpose: "ship the refund flow",
      invite: ["kolnet"],
    });
    expect(result.isError).not.toBe(true);

    expect(host.events("skid").map((e) => e.type)).toEqual([
      "create",
      "join",
      "invite",
    ]);
    const state = host.state("skid");
    expect(state.owner).toBe("skid");
    expect(state.members).toEqual(["skid"]);
    expect(state.pendingInvites).toEqual(["kolnet"]);

    const section = await roomSection($);
    expect(section?.text).toContain("#skid (owner skid)");
  });

  test("同名的 room 還開著就沿用，不重複建立", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    await boot($);
    const result = await tool($, "RoomCreate", {
      room: "payments",
      purpose: "again",
    });
    expect(result.isError).not.toBe(true);
    expect(String(result.result)).toContain("already open");
    expect(
      host.events("payments").filter((e) => e.type === "create"),
    ).toHaveLength(1);
  });

  test("同名但已關閉就回錯誤", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    host.write("payments", {
      type: "close",
      ts: 3,
      project: "kolnet",
      session: "s-k",
    });
    await boot($);
    const result = await tool($, "RoomCreate", {
      room: "payments",
      purpose: "again",
    });
    expect(result.isError).toBe(true);
  });
});

describe("RoomPost", () => {
  test("成員發言寫入 message 事件，帶 id、專案名與 session", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    await boot($);
    const result = await tool($, "RoomPost", {
      room: "payments",
      text: "API 改好了",
      to: ["kolnet"],
    });
    expect(result.isError).not.toBe(true);
    const last = host.events("payments").at(-1)!;
    expect(last).toEqual(
      expect.objectContaining({
        type: "message",
        project: "skid",
        session: "s-me",
        text: "API 改好了",
        to: ["kolnet"],
      }),
    );
    expect(typeof (last as { id?: unknown }).id).toBe("string");
  });

  test("不是成員、或 room 已關閉都不能發言", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments", ["kolnet"]);
    host.seedRoom("deploy");
    host.write("deploy", {
      type: "close",
      ts: 3,
      project: "kolnet",
      session: "s-k",
    });
    await boot($);
    expect(
      (await tool($, "RoomPost", { room: "payments", text: "hi" })).isError,
    ).toBe(true);
    expect(
      (await tool($, "RoomPost", { room: "deploy", text: "hi" })).isError,
    ).toBe(true);
    expect(host.events("payments").some((e) => e.type === "message")).toBe(
      false,
    );
  });
});

describe("RoomPost 與 Jev", () => {
  const noul = (p: number) => ({ type: "noul", noul: p });
  const withAsk = (host: ReturnType<typeof fakeHost>) => {
    host.seedRoom("payments");
    host.say("payments", "要用哪個幣別？", { id: "q1", kind: "ask" });
    host.env.TYPESAFE_API_KEY = "k";
  };

  test("自然語言回答了 open ask，Jev 判斷超過門檻就寫入 resolve", async ($, on) => {
    const host = await start($, on);
    withAsk(host);
    host.jev.answer = () => ({ answers_0: noul(0.92), isAsk: noul(0.1) });
    await boot($);
    const result = await tool($, "RoomPost", { room: "payments", text: "用 TWD" });

    expect(host.jev.calls).toHaveLength(1);
    expect(Object.keys(host.jev.calls[0]!.questions)).toEqual(["answers_0", "isAsk"]);
    expect(host.events("payments").at(-1)).toEqual(
      expect.objectContaining({ type: "resolve", ask: "q1", p: 0.92 }),
    );
    expect(host.state("payments").openAsks).toEqual([]);
    expect(String(result.result)).toMatch(/Jev closed ask q1 \(p=0\.92\)/);
  });

  test("沒標 kind 但 Jev 判斷是 ask，就寫入 ask-flag", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    host.env.TYPESAFE_API_KEY = "k";
    host.jev.answer = () => ({ isAsk: noul(0.88) });
    await boot($);
    const result = await tool($, "RoomPost", { room: "payments", text: "staging 可以重開嗎？" });
    const open = host.state("payments").openAsks;
    expect(open).toHaveLength(1);
    expect(open[0]?.text).toBe("staging 可以重開嗎？");
    expect(String(result.result)).toMatch(/Jev marked it as an ask/);
  });

  test("低於門檻什麼都不寫", async ($, on) => {
    const host = await start($, on);
    withAsk(host);
    host.jev.answer = () => ({ answers_0: noul(0.5), isAsk: noul(0.5) });
    await boot($);
    await tool($, "RoomPost", { room: "payments", text: "我晚點看" });
    expect(host.events("payments").at(-1)?.type).toBe("message");
    expect(host.state("payments").openAsks.map((m) => m.id)).toEqual(["q1"]);
  });

  test("差一點過門檻時提示 agent 自己補 answers，但不結案", async ($, on) => {
    const host = await start($, on);
    withAsk(host);
    host.jev.answer = () => ({ answers_0: noul(0.76), isAsk: noul(0.1) });
    await boot($);
    const result = await tool($, "RoomPost", { room: "payments", text: "用 TWD 吧" });
    expect(host.state("payments").openAsks.map((m) => m.id)).toEqual(["q1"]);
    expect(String(result.result)).toMatch(/may answer ask q1 \(p=0\.76\).*answers: "q1"/);
  });

  test("已經填了 answers 就不問 Jev", async ($, on) => {
    const host = await start($, on);
    withAsk(host);
    await boot($);
    await tool($, "RoomPost", { room: "payments", text: "用 TWD", answers: "q1" });
    expect(host.jev.calls).toHaveLength(0);
    expect(host.state("payments").openAsks).toEqual([]);
  });

  test("沒有 key 不打 API；Jev 失敗也照樣發出", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    await boot($);
    expect((await tool($, "RoomPost", { room: "payments", text: "a" })).isError).not.toBe(true);
    expect(host.jev.calls).toHaveLength(0);

    host.env.TYPESAFE_API_KEY = "k";
    host.jev.answer = () => undefined;
    const result = await tool($, "RoomPost", { room: "payments", text: "b" });
    expect(result.isError).not.toBe(true);
    expect(String(result.result)).toMatch(/Posted/);
    expect(host.events("payments").filter((e) => e.type === "message")).toHaveLength(2);
  });
});

describe("RoomInvite 與 RoomClose", () => {
  test("成員可以邀請，非成員不行", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    host.seedRoom("deploy", ["kolnet"]);
    await boot($);
    expect(
      (
        await tool($, "RoomInvite", {
          room: "payments",
          projects: ["yeshealth"],
        })
      ).isError,
    ).not.toBe(true);
    expect(host.state("payments").pendingInvites).toEqual(["yeshealth"]);
    expect(
      (await tool($, "RoomInvite", { room: "deploy", projects: ["yeshealth"] }))
        .isError,
    ).toBe(true);
  });

  test("只有 owner 能用 RoomClose", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    await boot($);
    expect((await tool($, "RoomClose", { room: "payments" })).isError).toBe(
      true,
    );
    expect(host.state("payments").isClosed).toBe(false);

    await tool($, "RoomCreate", { room: "mine", purpose: "x" });
    expect((await tool($, "RoomClose", { room: "mine" })).isError).not.toBe(
      true,
    );
    expect(host.state("mine").isClosed).toBe(true);
  });
});

describe("/izumo", () => {
  test("join / leave 寫進 room 檔，system prompt 跟著變", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments", ["kolnet"]);
    await boot($);
    expect(await roomSection($)).toBeUndefined();

    expect(await izumo($, "join payments")).toContain("#payments");
    expect(host.state("payments").members).toContain("skid");
    expect((await roomSection($))?.text).toContain("#payments (owner kolnet)");

    await izumo($, "leave payments");
    expect(host.state("payments").members).not.toContain("skid");
    expect(await roomSection($)).toBeUndefined();
  });

  test("join 不存在或已關閉的 room 會被拒", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("deploy", ["kolnet"]);
    host.write("deploy", {
      type: "close",
      ts: 3,
      project: "kolnet",
      session: "s-k",
    });
    await boot($);
    expect(await izumo($, "join nowhere")).toMatch(/no room/i);
    expect(await izumo($, "join deploy")).toMatch(/closed/i);
  });

  test("Dylan 用指令可以關任何 room", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    await boot($);
    expect(await izumo($, "close payments")).toContain("Closed #payments");
    expect(host.state("payments").isClosed).toBe(true);
  });

  test("list 顯示 owner、成員與 open ask；--all 也列出沒加入的", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    host.say("payments", "要用 TWD 嗎？", {
      kind: "ask",
      ts: 1000 - 2 * 24 * 60 * 60 * 1000,
    });
    host.seedRoom("deploy", ["kolnet"]);
    await boot($);
    const list = await izumo($, "list");
    expect(list).toContain("#payments");
    expect(list).toContain("owner kolnet");
    expect(list).toContain("kolnet, skid");
    expect(list).toMatch(/1 open ask.*2d/);
    expect(list).not.toContain("#deploy");
    expect(await izumo($, "list --all")).toContain("#deploy");
  });

  test("壞掉的參數回傳用法", async ($, on) => {
    await start($, on);
    await boot($);
    expect(await izumo($, "join ../etc")).toContain("Usage");
  });
});

describe("/izumo log", () => {
  test("不是成員也能看，顯示 purpose 與最近訊息", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments", ["kolnet"]);
    host.say("payments", "要用 TWD 嗎？", { id: "q1", kind: "ask" });
    await boot($);
    const text = await izumo($, "log payments");
    expect(text).toContain("#payments · owner kolnet");
    expect(text).toContain("coordinate payments");
    expect(text).toContain("[#payments] kolnet ask q1: 要用 TWD 嗎？ [open]");
  });

  test("不存在的 room 回錯誤", async ($, on) => {
    await start($, on);
    await boot($);
    expect(await izumo($, "log nowhere")).toMatch(/No room #nowhere/);
  });
});

describe("投遞", () => {
  test("別人的新訊息塞進對話一次，自己的跳過，啟動前的舊訊息不重送", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    host.say("payments", "old news");
    await boot($);

    host.say("payments", "from kolnet");
    host.say("payments", "from me", { session: "s-me", project: "skid" });
    await host.clock.advance(5000);
    expect(await eventually(() => host.appended.length > 0)).toBe(true);
    expect(host.appended).toEqual(["[#payments] kolnet: from kolnet"]);
    expect(host.toasts.join("\n")).toContain("#payments");

    await host.clock.advance(5000);
    await settle();
    expect(host.appended).toHaveLength(1);
  });

  test("沒加入的 room 的訊息不投遞", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments", ["kolnet"]);
    await boot($);
    host.say("payments", "not for you");
    await host.clock.advance(5000);
    await settle();
    expect(host.appended).toEqual([]);
  });

  test("上一輪還沒跑完時下一輪 tick 不重複投遞", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    await boot($);
    host.say("payments", "once");
    host.slow.readMs = 40;
    await host.clock.advance(5000);
    await host.clock.advance(5000);
    expect(await eventually(() => host.appended.length > 0)).toBe(true);
    await settle();
    expect(host.appended).toEqual(["[#payments] kolnet: once"]);
  });

  test("/clear 換了 session id 之後，用新的 id 判斷自己", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    await boot($);
    host.session.id = "s-new";
    host.say("payments", "before clear", { session: "s-me", project: "skid" });
    host.say("payments", "after clear", { session: "s-new", project: "skid" });
    await host.clock.advance(5000);
    expect(await eventually(() => host.appended.length > 0)).toBe(true);
    await settle();
    expect(host.appended).toEqual(["[#payments] skid: before clear"]);
  });

  test("指名這個專案時 toast 會標出來", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    await boot($);
    host.say("payments", "skid 看一下", { to: ["skid"] });
    await host.clock.advance(5000);
    expect(await eventually(() => host.toasts.length > 0)).toBe(true);
    expect(host.toasts.join("\n")).toMatch(/kolnet → you/);
  });

  test("room 被關閉時成員會收到通知", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    await boot($);
    host.write("payments", {
      type: "close",
      ts: 5,
      project: "kolnet",
      session: "s-k",
    });
    await host.clock.advance(5000);
    expect(await eventually(() => host.appended.length > 0)).toBe(true);
    expect(host.appended[0]).toContain("#payments was closed by kolnet");
  });
});

describe("邀請", () => {
  test("啟動時看到的邀請：自動加入、跳 toast，但不另外塞補讀", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments", ["kolnet"]);
    host.write("payments", {
      type: "invite",
      invitee: "skid",
      ts: 3,
      project: "kolnet",
      session: "s-k",
    });
    await boot($);
    expect(host.state("payments").members).toContain("skid");
    expect(host.toasts.join("\n")).toContain(
      "joined #payments (invited by kolnet)",
    );
    expect(host.appended).toEqual([]);
  });

  test("之後輪詢才看到的邀請：加入、toast，並塞入邀請通知與補讀", async ($, on) => {
    const host = await start($, on);
    await boot($);
    host.seedRoom("payments", ["kolnet"]);
    host.say("payments", "context before invite");
    host.write("payments", {
      type: "invite",
      invitee: "skid",
      ts: 3,
      project: "kolnet",
      session: "s-k",
    });
    await host.clock.advance(5000);
    expect(await eventually(() => host.appended.length > 0)).toBe(true);
    await settle();

    expect(host.state("payments").members).toContain("skid");
    expect(
      host
        .events("payments")
        .filter((e) => e.type === "join" && e.project === "skid"),
    ).toHaveLength(1);
    expect(host.toasts.join("\n")).toContain(
      "joined #payments (invited by kolnet)",
    );
    expect(host.appended.join("\n")).toContain("coordinate payments");
    expect(host.appended.join("\n")).toContain("context before invite");
  });
});

describe("新對話補讀", () => {
  test("prompt.context 帶 purpose 與最近訊息", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    host.say("payments", "recent thing", { ts: 900 });
    await boot($);
    const { blocks } = await $.prompt.context({ blocks: [] });
    const text = blocks.find((b) => b.name === "izumoRooms")?.text ?? "";
    expect(text).toContain("coordinate payments");
    expect(text).toContain("[#payments] kolnet: recent thing");
  });

  test("沒加入 room 時不加 block", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments", ["kolnet"]);
    await boot($);
    const { blocks } = await $.prompt.context({ blocks: [] });
    expect(blocks.find((b) => b.name === "izumoRooms")).toBeUndefined();
  });
});

describe("/resume", () => {
  const MINUTE = 60_000;

  test("補送離開期間的訊息，已經在 transcript 裡的、自己的、離開前的都不送", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    await boot($);
    await host.clock.advance(10 * MINUTE);
    const now = 1000 + 10 * MINUTE;
    host.say("payments", "before leaving", { id: "a", ts: now - 5 * MINUTE });
    host.say("payments", "while away 1", { id: "b", ts: now - 2 * MINUTE });
    host.say("payments", "while away 2", { id: "c", ts: now - MINUTE });
    host.say("payments", "mine while away", { id: "d", ts: now - MINUTE, project: "skid", session: "s-me" });
    host.say("payments", "already seen", { id: "e", ts: now - MINUTE });
    host.transcript.push("[#payments] kolnet: already seen");

    await $.classic.SessionStart({ source: "resume", seconds_since_last_response: 180 } as never);
    expect(host.appended).toEqual(["[#payments] kolnet: while away 1", "[#payments] kolnet: while away 2"]);

    // the poll that follows must not deliver them again
    await host.clock.advance(5000);
    await settle();
    expect(host.appended).toHaveLength(2);
  });

  test("不是 resume 就不補送", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    host.say("payments", "x", { ts: 999 });
    await boot($);
    await $.classic.SessionStart({ source: "startup" } as never);
    expect(host.appended).toEqual([]);
  });
});

// every Markdown body in a drawn tree, in document order
const markdownTexts = (node: unknown): string[] => {
  if (typeof node !== "object" || node === null) return [];
  const { type, props, children } = node as { type?: string; props?: { text?: string }; children?: unknown[] };
  const own = type === "Markdown" && typeof props?.text === "string" ? [props.text] : [];
  return [...own, ...(children ?? []).flatMap(markdownTexts)];
};

const pane = (room: string) =>
  ({
    component: "Pane",
    requestId: `izumo-${room}`,
    props: {
      title: `#${room}`,
      isFocused: false,
      bodyColumns: 80,
      placement: "dock",
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const;

describe("/izumo show", () => {
  test("開一個以 room 命名的 pane", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    await boot($);
    expect(await izumo($, "show payments")).toContain("#payments");
    // the person asked for it to work in it, so it takes the keyboard
    expect(host.opened).toEqual(["izumo-payments (focus)"]);
    expect(await izumo($, "show nowhere")).toMatch(/No room #nowhere/);
  });

  for (const surface of ["terminal", "desktop"] as const) {
    test(`pane 顯示 room，並能以 Dylan 回答 ask 與發言（${surface}）`, async ($, on) => {
      const host = await start($, on);
      host.seedRoom("payments");
      host.say("payments", "要用 TWD 嗎？", { id: "q1", kind: "ask", to: ["dylan"] });
      host.say("payments", "- staging 已更新\n- 跑 `db:migrate`");
      await boot($);

      const ui = await $.ui.mount({ plugin: "izumo", surface, ...pane("payments") });
      expect(await ui.find({ text: /^#payments$/ })).toBeDefined();
      expect(await ui.find({ text: /owner kolnet · kolnet, skid/ })).toBeDefined();
      expect(await ui.find({ text: /coordinate payments/ })).toBeDefined();

      // each message: a header with the project in its own color, then the body as Markdown
      expect((await ui.find({ type: "Text", text: /^kolnet$/ }))?.props.color).toBe(projectColor("kolnet"));
      expect((await ui.find({ type: "Text", text: /ask q1/ }))?.props.color).toBe("warning");
      expect(await ui.find({ text: /→ dylan/ })).toBeDefined();
      expect(markdownTexts(await ui.drawn())).toEqual(["要用 TWD 嗎？", "- staging 已更新\n- 跑 `db:migrate`"]);
      expect((await ui.find({ key: "asks" }))?.props.borderStyle).toBeDefined();
      expect((await ui.find({ key: "answer-q1" }))?.props.autoFocus).toBe(true);

      await ui.input({ key: "answer-q1", text: "用 TWD" });
      expect(host.events("payments").at(-1)).toEqual(
        expect.objectContaining({ type: "message", project: "dylan", session: "dylan", answers: "q1", text: "用 TWD" }),
      );
      expect(host.state("payments").openAsks).toEqual([]);
      await ui.redraw();
      expect(await ui.find({ key: "answer-q1" })).toBeUndefined();
      expect(await ui.find({ key: "asks" })).toBeUndefined();
      expect((await ui.find({ type: "Text", text: /^dylan$/ }))?.props.color).toBe("warning");
      expect((await ui.find({ type: "Text", text: /re q1/ }))?.props.color).toBe("success");

      await ui.input({ key: "say", text: "週五上線" });
      expect(host.events("payments").at(-1)).toEqual(
        expect.objectContaining({ project: "dylan", text: "週五上線" }),
      );
      await ui.unmount();
    });
  }

  test("Dylan 的訊息會投遞給成員，包括開著 pane 的這個 session", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    await boot($);
    const ui = await $.ui.mount({ plugin: "izumo", surface: "terminal", ...pane("payments") });
    await ui.input({ key: "say", text: "週五上線" });
    await host.clock.advance(5000);
    expect(await eventually(() => host.appended.length > 0)).toBe(true);
    expect(host.appended).toEqual(["[#payments] dylan: 週五上線"]);
    await ui.unmount();
  });

  test("沒有 Input 的 surface（mobile）只顯示內容", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    host.say("payments", "要用 TWD 嗎？", { id: "q1", kind: "ask" });
    await boot($);
    const ui = await $.ui.mount({ plugin: "izumo", surface: "mobile", ...pane("payments") });
    expect(markdownTexts(await ui.drawn())).toEqual(["要用 TWD 嗎？"]);
    expect(await ui.find({ key: "answer-q1" })).toBeUndefined();
    expect(await ui.find({ key: "say" })).toBeUndefined();
    await ui.unmount();
  });

  test("關閉的 room 沒有輸入框", async ($, on) => {
    const host = await start($, on);
    host.seedRoom("payments");
    host.write("payments", { type: "close", ts: 3, project: "kolnet", session: "s-k" });
    await boot($);
    const ui = await $.ui.mount({ plugin: "izumo", surface: "terminal", ...pane("payments") });
    expect(await ui.find({ text: /closed/ })).toBeDefined();
    expect(await ui.find({ key: "say" })).toBeUndefined();
    await ui.unmount();
  });
});
