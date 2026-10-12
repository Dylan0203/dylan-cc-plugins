import { describe, expect, test } from "claude-code/testing";

import {
  briefDigest,
  isHumanPrompt,
  parseTranscript,
  type TranscriptRecord,
} from "./brief";
import { foldRoom, type RoomEvent } from "./rooms";

const T0 = Date.parse("2026-10-12T08:00:00Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(T0 + minutes * MINUTE).toISOString();

const typed = (text: string, minutes: number): TranscriptRecord => ({
  type: "user",
  origin: { kind: "human" },
  timestamp: at(minutes),
  message: { role: "user", content: text },
});
const reply = (text: string, minutes: number): TranscriptRecord => ({
  type: "assistant",
  timestamp: at(minutes),
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const peer = (
  name: string,
  body: string,
  minutes: number,
  isHandback = false,
): TranscriptRecord => ({
  type: "user",
  isMeta: true,
  origin: {
    kind: "peer",
    name,
    body,
    ...(isHandback ? { handback: true } : {}),
  },
  timestamp: at(minutes),
  message: {
    role: "user",
    content: [
      { type: "text", text: `Another Claude session sent a message:\n${body}` },
    ],
  },
});

const room = (events: RoomEvent[]) => foldRoom(events);
const msg = (
  over: Partial<Extract<RoomEvent, { type: "message" }>>,
): RoomEvent => ({
  type: "message",
  id: "m1",
  text: "hi",
  ts: T0,
  project: "kolnet",
  session: "s-k",
  ...over,
});

const digest = (
  records: TranscriptRecord[],
  rooms = [] as { room: string; state: ReturnType<typeof foldRoom> }[],
) => briefDigest({ records, rooms, human: "dylan", now: T0 + 60 * MINUTE });

describe("parseTranscript", () => {
  test("tail 開頭被切斷的那一行與壞掉的行都略過", () => {
    const text = [
      '"type":"user"}',
      JSON.stringify(typed("hi", 0)),
      "not json",
      "",
    ].join("\n");
    expect(parseTranscript(text)).toEqual([typed("hi", 0)]);
  });
});

describe("isHumanPrompt", () => {
  test("使用者在終端機打的字", () => {
    expect(isHumanPrompt(typed("go", 0))).toBe(true);
  });

  test("compact 摘要、slash command、peer、izumo 的訊息、叫醒 prompt、tool result 都不算", () => {
    expect(
      isHumanPrompt({
        ...typed("This session is being continued", 0),
        isCompactSummary: true,
      }),
    ).toBe(false);
    expect(
      isHumanPrompt(
        typed(
          "<command-message>brief</command-message>\n<command-name>/brief</command-name>",
          0,
        ),
      ),
    ).toBe(false);
    expect(isHumanPrompt(peer("dev", "kickoff", 0))).toBe(false);
    expect(
      isHumanPrompt({
        ...typed("[#payments] kolnet: hi", 0),
        isMeta: true,
        origin: { kind: "plugin", name: "izumo" },
      }),
    ).toBe(false);
    expect(
      isHumanPrompt({
        ...typed("[izumo] #payments has 1 message", 0),
        origin: { kind: "plugin", name: "izumo" },
      }),
    ).toBe(false);
    expect(
      isHumanPrompt({
        type: "user",
        timestamp: at(0),
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "ok" }],
        },
      }),
    ).toBe(false);
  });

  test("舊版 transcript 沒有 origin：不是 meta、不是 tag 開頭的就算", () => {
    const { origin: _, ...old } = typed("1. ok 2. yes", 0);
    expect(isHumanPrompt(old)).toBe(true);
    expect(isHumanPrompt({ ...old, isMeta: true })).toBe(false);
    expect(
      isHumanPrompt({
        ...old,
        message: {
          role: "user",
          content: "<local-command-stdout>x</local-command-stdout>",
        },
      }),
    ).toBe(false);
  });
});

describe("briefDigest", () => {
  test("最後一個 prompt 是使用者打的字，不是 compact 摘要或 /izumo:brief 本身", () => {
    const text = digest([
      typed("做，go", 0),
      {
        ...typed("This session is being continued", 5),
        isCompactSummary: true,
      },
      typed("<command-name>/izumo:brief</command-name>", 9),
    ]);
    expect(text).toContain("LAST_PROMPT 做，go");
    expect(text).toContain(`LAST_PROMPT_AT ${at(0)}`);
    expect(text).not.toContain("WINDOW_TRUNCATED");
  });

  test("讀到的範圍裡沒有使用者的 prompt 時明講", () => {
    expect(digest([reply("still working", 1)])).toMatch(/^WINDOW_TRUNCATED/m);
  });

  test("列出所有開著的 room 裡給使用者、還沒結案的 ask", () => {
    const payments = room([
      {
        type: "create",
        purpose: "pay",
        ts: T0 - 3 * 24 * 60 * MINUTE,
        project: "kolnet",
        session: "s-k",
      },
      msg({
        id: "q1",
        text: "幣別用哪個？",
        kind: "ask",
        to: ["dylan"],
        ts: T0 - 2 * 24 * 60 * MINUTE,
      }),
      msg({ id: "q2", text: "skid 看一下？", kind: "ask", to: ["skid"] }),
      msg({ id: "q3", text: "已回的", kind: "ask", to: ["dylan"] }),
      msg({
        id: "a3",
        text: "好",
        answers: "q3",
        project: "dylan",
        session: "dylan",
      }),
    ]);
    const closed = room([
      {
        type: "create",
        purpose: "old",
        ts: T0,
        project: "skid",
        session: "s-s",
      },
      msg({ id: "q9", kind: "ask", to: ["dylan"] }),
      { type: "close", ts: T0, project: "skid", session: "s-s" },
    ]);
    const text = digest(
      [typed("go", 0)],
      [
        { room: "payments", state: payments },
        { room: "old", state: closed },
      ],
    );
    const asks = text.split("=== OPEN ASKS FOR dylan ===")[1]!.split("===")[0]!;
    expect(asks).toContain("#payments ask q1 · kolnet · 2d: 幣別用哪個？");
    expect(asks).not.toContain("q2");
    expect(asks).not.toContain("q3");
    expect(asks).not.toContain("q9");
  });

  test("room 新訊息只列使用者上次打字之後的，不含使用者自己發的，也不重複列 ask", () => {
    const payments = room([
      {
        type: "create",
        purpose: "pay",
        ts: T0 - MINUTE,
        project: "kolnet",
        session: "s-k",
      },
      msg({ id: "old", text: "before", ts: T0 - MINUTE }),
      msg({ id: "new", text: "after", ts: T0 + 10 * MINUTE }),
      msg({
        id: "mine",
        text: "我說的",
        ts: T0 + 11 * MINUTE,
        project: "dylan",
        session: "dylan",
      }),
      msg({
        id: "q1",
        text: "決定？",
        kind: "ask",
        to: ["dylan"],
        ts: T0 + 12 * MINUTE,
      }),
    ]);
    const text = digest(
      [typed("go", 0)],
      [{ room: "payments", state: payments }],
    );
    const since = text.split("=== ROOM MESSAGES SINCE")[1]!.split("\n===")[0]!;
    expect(since).toContain("[#payments] kolnet: after");
    expect(since).not.toContain("before");
    expect(since).not.toContain("我說的");
    expect(since).not.toContain("決定？");
  });

  test("peer 訊息列出，subagent 的回報不算", () => {
    const text = digest([
      typed("go", 0),
      peer("kolnet", "GlitchTip id 換了", 5),
      peer("chronicle:lawspeaker", "simple commit", 6, true),
    ]);
    const peers = text
      .split("=== PEER MESSAGES SINCE ===")[1]!
      .split("\n===")[0]!;
    expect(peers).toContain("from kolnet");
    expect(peers).toContain("GlitchTip id 換了");
    expect(peers).not.toContain("lawspeaker");
    expect(text).toContain("PEER_MESSAGE_COUNT 1");
  });

  test("我的回覆只列使用者上次打字之後的", () => {
    const text = digest([
      reply("舊的回覆", 0),
      typed("go", 1),
      reply("新的回覆", 2),
    ]);
    const mine = text.split("=== MY REPLIES SINCE ===")[1]!.split("\n===")[0]!;
    expect(mine).toContain("新的回覆");
    expect(mine).not.toContain("舊的回覆");
  });

  test("決策候選只看倒數第三個 prompt 之後，含問句，並標出之後有沒有回應", () => {
    const text = digest([
      reply("要你決定：很久以前的事", 0),
      typed("p1", 1),
      reply("我的建議：先做 B", 2),
      typed("p2", 3),
      reply("改好了。\n\n要我順便調門檻嗎？", 4),
      typed("p3", 5),
      reply("測試都過了。\n\n要不要 push？", 6),
    ]);
    const candidates = text.split("=== DECISION CANDIDATES ===")[1]!;
    expect(candidates).not.toContain("很久以前");
    expect(candidates).toMatch(/replied after.*我的建議：先做 B/);
    expect(candidates).toMatch(/replied after.*要我順便調門檻嗎？/);
    expect(candidates).toMatch(/no reply yet.*要不要 push？/);
    expect(candidates).not.toContain("改好了");
  });
});
