// Pure helpers for /izumo:brief: what the user missed since they last typed, read from the
// session's transcript and every room. The skill's model turns the digest into the brief.

import { ago, formatMessage, type MessageEvent, type RoomState } from "./rooms";

export type TranscriptRecord = {
  type?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  timestamp?: string;
  // the engine's own stamp of where a row came from; older transcripts lack it
  origin?: { kind: string; name?: string; body?: string; handback?: boolean };
  message?: {
    role?: string;
    content?:
      | string
      | readonly { type: string; text?: string; content?: unknown }[];
  };
};

// A line that fails to parse is the one a byte-count tail cut through, or a torn write.
export const parseTranscript = (text: string): TranscriptRecord[] =>
  text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" && parsed !== null
        ? [parsed as TranscriptRecord]
        : [];
    } catch {
      return [];
    }
  });

const textOf = (r: TranscriptRecord): string => {
  const content = r.message?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .flatMap((b) => (b.type === "text" && b.text ? [b.text] : []))
    .join("\n");
};

const hasToolResult = (r: TranscriptRecord) =>
  Array.isArray(r.message?.content) &&
  r.message.content.some((b) => b.type === "tool_result");

// Rows the engine writes as user rows that the user never typed, recognised by their opening tag.
const NOT_TYPED = [
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<system-reminder>",
  "<cross-session-message",
];

export const isHumanPrompt = (r: TranscriptRecord): boolean => {
  if (r.type !== "user" || r.isCompactSummary || hasToolResult(r)) return false;
  if (r.origin ? r.origin.kind !== "human" : r.isMeta) return false;
  const text = textOf(r);
  if (!text.trim()) return false;
  // a slash command is stamped human too, /izumo:brief itself included
  const head = text.trimStart().slice(0, 600);
  return !NOT_TYPED.some((tag) => head.includes(tag));
};

const MARKERS =
  /(要你決定|你要決定|等你決定|還在等你|等你的|問你|請你決定|你說了算|你選哪|我的建議|建議你|需要你|待你|懸著|沒回|要你拍板|你拍板|your call|up to you|need you to|waiting on you|⏳)/i;
const RECENT_MS = 3 * 24 * 60 * 60 * 1000;
const ROOM_MAX = 20;

const stamp = (r: TranscriptRecord) =>
  (r.timestamp ?? "?").slice(0, 16).replace("T", " ");
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

type Input = {
  records: readonly TranscriptRecord[];
  rooms: readonly { room: string; state: RoomState }[];
  human: string;
  now: number;
};

export const briefDigest = ({ records, rooms, human, now }: Input): string => {
  const prompts = records.flatMap((r, i) => (isHumanPrompt(r) ? [i] : []));
  const last = prompts.at(-1);
  const lastRecord = last === undefined ? undefined : records[last];
  const sinceTs = lastRecord?.timestamp
    ? Date.parse(lastRecord.timestamp)
    : now - RECENT_MS;
  const after = last === undefined ? records : records.slice(last + 1);
  const out: string[] = [];

  if (lastRecord === undefined)
    out.push(
      "WINDOW_TRUNCATED no prompt of the user's in the part of the transcript read; lean on your own context for what happened before it.",
    );
  else
    out.push(
      `LAST_PROMPT_AT ${lastRecord.timestamp}`,
      `LAST_PROMPT ${clip(textOf(lastRecord).trim(), 500)}`,
    );

  const open = rooms.filter(({ state }) => !state.isClosed);
  out.push("", `=== OPEN ASKS FOR ${human} ===`);
  const asksForHuman = new Set<string>();
  for (const { room, state } of open)
    for (const m of state.openAsks.filter((a) => a.to?.includes(human))) {
      asksForHuman.add(m.id);
      out.push(
        `#${room} ask ${m.id} · ${m.project} · ${ago(now - m.ts)}: ${m.text}`,
      );
    }
  if (asksForHuman.size === 0) out.push("(none)");

  out.push(
    "",
    `=== ROOM MESSAGES SINCE ${lastRecord ? lastRecord.timestamp : "the last 3 days"} ===`,
  );
  const fresh = open.flatMap(({ room, state }) =>
    state.messages
      .filter(
        (m: MessageEvent) =>
          m.ts > sinceTs && m.project !== human && !asksForHuman.has(m.id),
      )
      .slice(-ROOM_MAX)
      .map((m) => `${formatMessage(room, m)} (${ago(now - m.ts)} ago)`),
  );
  out.push(...(fresh.length ? fresh : ["(none)"]));

  out.push("", "=== PEER MESSAGES SINCE ===");
  const peers = after.filter(
    (r) => r.origin?.kind === "peer" && !r.origin.handback,
  );
  for (const r of peers)
    out.push(
      `--- [${stamp(r)}] from ${r.origin!.name ?? "?"} ---`,
      clip((r.origin!.body ?? textOf(r)).trim(), 2500),
    );
  out.push(`PEER_MESSAGE_COUNT ${peers.length}`);

  out.push("", "=== MY REPLIES SINCE ===");
  for (const r of after.filter((r) => r.type === "assistant")) {
    const text = textOf(r).trim();
    if (text) out.push("---", clip(text, 1200));
  }

  // the last three prompts' worth: older questions were answered or overtaken long ago
  out.push("", "=== DECISION CANDIDATES ===");
  const from = prompts.length >= 3 ? prompts.at(-3)! + 1 : 0;
  records.slice(from).forEach((r, offset) => {
    if (r.type !== "assistant") return;
    const index = from + offset;
    const answered = prompts.some((p) => p > index)
      ? "replied after"
      : "no reply yet";
    for (const paragraph of textOf(r).split(/\n{2,}/)) {
      const flat = paragraph.split(/\s+/).join(" ").trim();
      if (MARKERS.test(flat) || /[?？]$/.test(flat))
        out.push(`[${stamp(r)} · ${answered}] ${clip(flat, 300)}`);
    }
  });

  return out.join("\n");
};
