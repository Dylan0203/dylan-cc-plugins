import type { EngineInterface as Engine, Register } from "claude-code";

import {
  catchUpText,
  composeText,
  foldRoom,
  formatMessage,
  isRoomName,
  logText,
  newId,
  parseCommand,
  parseEvents,
  projectName,
  readSince,
  toLine,
  type MessageEvent,
  type RoomEvent,
  type RoomState,
} from "./rooms";
import { askJev, buildQuestions, jevVerdicts } from "./jev";

const POLL_MS = 5000;
const JEV_TIMEOUT_MS = 3000;
// provisional; tune once real rooms show how Jev scores answers and asks
const JEV_THRESHOLD = 0.8;

type Room = { room: string; state: RoomState };
type Answer = { result: string; isError?: true };

// How far this process has delivered each room file: the text offset readSince continues
// from, and the file's size at that read, so an unchanged room costs nothing past the listing.
// Tools and prompts fold rooms fresh from disk; only delivery needs a cursor.
const cursors = new Map<string, { offset: number; size: number }>();
// clock.every does not wait for an async callback, so a slow poll would overlap the next tick
let isPolling = false;

async function roomsDir($: Engine) {
  return `${await $.env.get("HOME")}/.claude/rooms`;
}

async function readRoom($: Engine, room: string) {
  return $.fs.read(`${await roomsDir($)}/${room}.jsonl`).catch(() => undefined);
}

async function loadRoom(
  $: Engine,
  room: string,
): Promise<RoomState | undefined> {
  const text = await readRoom($, room);
  return text === undefined ? undefined : foldRoom(parseEvents(text));
}

async function listRoomFiles($: Engine) {
  const entries = await $.fs.list(await roomsDir($)).catch(() => []);
  return entries
    .filter((e) => e.kind === "file" && e.name.endsWith(".jsonl"))
    .map((e) => ({ room: e.name.slice(0, -".jsonl".length), size: e.size }));
}

async function allRooms($: Engine): Promise<Room[]> {
  const rooms: Room[] = [];
  for (const { room } of await listRoomFiles($)) {
    const state = await loadRoom($, room);
    if (state) rooms.push({ room, state });
  }
  return rooms;
}

async function me($: Engine) {
  return projectName(await $.session.root());
}

const isMember = (state: RoomState, project: string) =>
  state.members.includes(project) && !state.isClosed;

async function myRooms($: Engine): Promise<Room[]> {
  const project = await me($);
  return (await allRooms($)).filter(({ state }) => isMember(state, project));
}

async function write($: Engine, room: string, event: RoomEvent) {
  const dir = await roomsDir($);
  const path = `${dir}/${room}.jsonl`;
  await $.process.run(["mkdir", "-p", dir]);
  // O_APPEND through the shell so two sessions writing at once never overwrite each other;
  // the event goes in on stdin, never through shell parsing
  const { exitCode, stderr } = await $.process.run(
    ["sh", "-c", 'cat >> "$1"', "sh", path],
    {
      stdin: toLine(event),
    },
  );
  if (exitCode !== 0) throw new Error(`append to ${path} failed: ${stderr}`);
}

async function stamp($: Engine) {
  return {
    ts: await $.clock.now(),
    project: await me($),
    session: await $.session.id(),
  };
}

async function say($: Engine, text: string) {
  await $.session.append({
    message: { type: "user", content: [{ type: "text", text }] },
  });
}

// Join every room that invited this project. Delivery is for invites a poll notices later:
// at startup the first prompt's catch-up already carries those rooms.
async function acceptInvites(
  $: Engine,
  rooms: readonly Room[],
  isLive: boolean,
) {
  const project = await me($);
  for (const { room, state } of rooms) {
    if (state.isClosed || !state.pendingInvites.includes(project)) continue;
    await write($, room, { type: "join", ...(await stamp($)) });
    $.ui.toast(
      `izumo: joined #${room} (invited by ${state.owner ?? "someone"})`,
    );
    if (!isLive) continue;
    const joined = (await loadRoom($, room)) ?? state;
    const catchUp = catchUpText([{ room, state: joined }], await $.clock.now());
    await say(
      $,
      `You were invited to izumo room #${room} by ${state.owner ?? "someone"}.\n${catchUp ?? ""}`,
    );
  }
}

function toastFor(
  room: string,
  project: string,
  fresh: readonly MessageEvent[],
) {
  const addressed = fresh
    .filter((m) => m.to?.includes(project))
    .map((m) => `${m.project} → you`);
  const forDylan = fresh.some(
    (m) => m.kind === "ask" && m.to?.includes("dylan"),
  )
    ? ["ask for Dylan"]
    : [];
  const notes = [...new Set([...addressed, ...forDylan])];
  return `izumo #${room}: ${fresh.length} new${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

async function poll($: Engine) {
  const project = await me($);
  const mine = await $.session.id();
  const changed: Room[] = [];
  for (const { room, size } of await listRoomFiles($)) {
    // a room created after this session started is read from its start
    const cursor = cursors.get(room) ?? { offset: 0, size: -1 };
    if (size === cursor.size) continue;
    const text = await readRoom($, room);
    if (text === undefined) continue;
    const read = readSince(text, cursor.offset);
    cursors.set(room, { offset: read.offset, size });
    const state = foldRoom(parseEvents(text));
    changed.push({ room, state });
    if (!state.members.includes(project)) continue;

    const fresh = read.events.filter(
      (e): e is MessageEvent => e.type === "message" && e.session !== mine,
    );
    for (const m of fresh) await say($, formatMessage(room, m));
    if (fresh.length > 0) $.ui.toast(toastFor(room, project, fresh));
    const closed = read.events.find((e) => e.type === "close");
    if (closed)
      await say($, `[#${room}] #${room} was closed by ${closed.project}.`);
  }
  await acceptInvites($, changed, true);
}

async function skipToEnd($: Engine) {
  for (const { room, size } of await listRoomFiles($))
    cursors.set(room, { offset: (await readRoom($, room))?.length ?? 0, size });
}

const RESUME_MAX = 20;

// A resumed conversation already has its first message, so prompt.context never runs again;
// fill what arrived while it was away, skipping rows its transcript already holds.
async function fillGap($: Engine, secondsAway: number) {
  const since = (await $.clock.now()) - secondsAway * 1000;
  const mine = await $.session.id();
  const seen = new Set((await $.session.messages()).map((m) => m.text));
  const missed = (await myRooms($))
    .flatMap(({ room, state }) =>
      state.messages
        .filter((m) => m.ts > since && m.session !== mine)
        .map((m) => ({ ts: m.ts, text: formatMessage(room, m) })),
    )
    .filter(({ text }) => !seen.has(text))
    .sort((a, b) => a.ts - b.ts)
    .slice(-RESUME_MAX);
  for (const { text } of missed) await say($, text);
  // the poll would otherwise deliver whatever its cursors had not reached yet a second time
  await skipToEnd($);
}

const ago = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
};

async function listText($: Engine, isAll: boolean) {
  const project = await me($);
  const now = await $.clock.now();
  const rooms = (await allRooms($)).filter(
    ({ state }) => isAll || isMember(state, project),
  );
  if (rooms.length === 0)
    return isAll
      ? "No izumo rooms yet."
      : "Not in any izumo room. /izumo list --all";
  return rooms
    .map(({ room, state }) => {
      const asks = state.openAsks;
      const oldest = asks.length
        ? `, oldest ${ago(now - Math.min(...asks.map((m) => m.ts)))}`
        : "";
      return [
        `#${room}${state.isClosed ? " (closed)" : ""} · owner ${state.owner ?? "unknown"} · ${state.members.join(", ") || "no members"}`,
        `  last activity ${ago(now - state.lastTs)} ago · ${asks.length} open ask${asks.length === 1 ? "" : "s"}${oldest}`,
      ].join("\n");
    })
    .join("\n");
}

type ToolInput = {
  room?: string;
  purpose?: string;
  invite?: string[];
  projects?: string[];
  text?: string;
  to?: string[];
  kind?: "ask";
  answers?: string;
};

async function invite(
  $: Engine,
  room: string,
  state: RoomState,
  projects: readonly string[],
) {
  const invited = projects.filter((p) => !state.members.includes(p));
  for (const invitee of invited)
    await write($, room, { type: "invite", invitee, ...(await stamp($)) });
  return invited;
}

async function roomCreate($: Engine, input: ToolInput): Promise<Answer> {
  const room = input.room ?? (await me($));
  if (!isRoomName(room))
    return {
      result: `Invalid room "${room}": use a-z, 0-9 and -.`,
      isError: true,
    };
  const existing = await loadRoom($, room);
  if (existing?.isClosed)
    return {
      result: `#${room} exists and is closed. Pick another name.`,
      isError: true,
    };
  if (existing)
    return {
      result: `#${room} is already open (owner ${existing.owner ?? "unknown"}, members ${existing.members.join(", ")}). Use RoomInvite to add projects.`,
    };
  await write($, room, {
    type: "create",
    purpose: input.purpose ?? "",
    ...(await stamp($)),
  });
  await write($, room, { type: "join", ...(await stamp($)) });
  const invited = await invite($, room, foldRoom([]), input.invite ?? []);
  return {
    result: `Created #${room}${invited.length ? `, invited ${invited.join(", ")}` : ""}.`,
  };
}

async function memberRoom($: Engine, room: string | undefined) {
  if (room === undefined || !isRoomName(room))
    return { error: `Invalid room "${room}".` };
  const state = await loadRoom($, room);
  if (state === undefined) return { error: `No room #${room}.` };
  if (state.isClosed) return { error: `#${room} is closed.` };
  if (!state.members.includes(await me($)))
    return { error: `Not a member of #${room}.` };
  return { room, state };
}

async function roomInvite($: Engine, input: ToolInput): Promise<Answer> {
  const found = await memberRoom($, input.room);
  if ("error" in found) return { result: found.error!, isError: true };
  const invited = await invite(
    $,
    found.room,
    found.state,
    input.projects ?? [],
  );
  return {
    result: invited.length
      ? `Invited ${invited.join(", ")} to #${found.room}.`
      : "Nobody new to invite.",
  };
}

// Runs only in the poster's session, so each message is judged once rather than once per member.
// Never throws: the message is already written, so a failure here must not read as "not posted".
async function jevCheck($: Engine, room: string, state: RoomState, message: MessageEvent) {
  try {
    const asks = message.answers === undefined ? state.openAsks : [];
    const needsKind = message.kind === undefined && message.answers === undefined;
    const request = buildQuestions(message, asks, needsKind);
    const result = await askJev(request, {
      apiKey: await $.env.get("TYPESAFE_API_KEY"),
      fetch: (url, init) => $.http.fetch(url, init),
      timeout: () => $.clock.sleep(JEV_TIMEOUT_MS),
    });
    if ("skipped" in result) {
      const isQuiet = result.skipped === "TYPESAFE_API_KEY not set" || result.skipped === "nothing to ask";
      return isQuiet ? "" : ` Jev check skipped: ${result.skipped}.`;
    }
    const verdicts = jevVerdicts(result.answers, asks, JEV_THRESHOLD);
    const notes: string[] = [];
    for (const { ask, p } of verdicts.resolved) {
      await write($, room, { type: "resolve", ask, p, ...(await stamp($)) });
      notes.push(` Jev closed ask ${ask} (p=${p}).`);
    }
    for (const { ask, p } of verdicts.maybe)
      notes.push(` Jev thinks this may answer ask ${ask} (p=${p}); if it does, post a short follow-up with answers: "${ask}".`);
    if (verdicts.isAsk !== undefined) {
      await write($, room, { type: "ask-flag", id: message.id, ...(await stamp($)) });
      notes.push(` Jev marked it as an ask (${message.id}, p=${verdicts.isAsk}); set kind: "ask" yourself next time.`);
    }
    return notes.join("");
  } catch (err) {
    return ` Jev check failed: ${err instanceof Error ? err.message : String(err)}.`;
  }
}

async function roomPost($: Engine, input: ToolInput): Promise<Answer> {
  const found = await memberRoom($, input.room);
  if ("error" in found) return { result: found.error!, isError: true };
  const at = await stamp($);
  const message: MessageEvent = {
    type: "message",
    id: newId(at.ts),
    text: input.text ?? "",
    ...(input.to?.length ? { to: input.to } : {}),
    ...(input.kind === "ask" ? { kind: "ask" as const } : {}),
    ...(input.answers ? { answers: input.answers } : {}),
    ...at,
  };
  await write($, found.room, message);
  const asAsk = message.kind === "ask" ? ` as ask ${message.id}` : "";
  const jev = await jevCheck($, found.room, found.state, message);
  return { result: `Posted to #${found.room}${asAsk}.${jev}` };
}

async function roomClose($: Engine, input: ToolInput): Promise<Answer> {
  const found = await memberRoom($, input.room);
  if ("error" in found) return { result: found.error!, isError: true };
  if (found.state.owner !== (await me($)))
    return {
      result: `Only #${found.room}'s owner (${found.state.owner}) or Dylan can close it.`,
      isError: true,
    };
  await write($, found.room, { type: "close", ...(await stamp($)) });
  return { result: `Closed #${found.room}.` };
}

async function command($: Engine, args: string) {
  const command = parseCommand(args);
  if (command.kind === "error") return command.text;
  if (command.kind === "list") return listText($, command.isAll);
  const { room } = command;
  const state = await loadRoom($, room);
  if (state === undefined)
    return `No room #${room}. Rooms are created with /izumo:create-room.`;
  const project = await me($);
  switch (command.kind) {
    case "join":
      if (state.isClosed) return `#${room} is closed.`;
      if (!state.members.includes(project))
        await write($, room, { type: "join", ...(await stamp($)) });
      return `Joined #${room}`;
    case "leave":
      if (state.members.includes(project))
        await write($, room, { type: "leave", ...(await stamp($)) });
      return `Left #${room}`;
    case "close":
      // the person typed it, so no owner check: Dylan can retire any room
      if (!state.isClosed)
        await write($, room, { type: "close", ...(await stamp($)) });
      return `Closed #${room}`;
    case "log":
      return logText(room, state, command.count);
    case "show":
      return "/izumo show is not built yet.";
  }
}

const ROOM_PROP = {
  type: "string",
  description: "Room name without #, e.g. payments",
};
const PROJECTS = {
  type: "array",
  items: { type: "string" },
  description: "Project folder names, e.g. skid",
};

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.tool.register({
      name: "RoomCreate",
      description:
        "Create an izumo room shared with agents in Dylan's other projects, and invite projects to it. The room defaults to this project's name; an open room with that name is reused.",
      inputSchema: {
        type: "object",
        properties: {
          room: ROOM_PROP,
          purpose: {
            type: "string",
            description: "One line: what the room is for",
          },
          invite: PROJECTS,
        },
        required: ["purpose"],
      },
    });
    await $.tool.register({
      name: "RoomInvite",
      description:
        "Invite projects to an izumo room you are in; their agents join automatically.",
      inputSchema: {
        type: "object",
        properties: { room: ROOM_PROP, projects: PROJECTS },
        required: ["room", "projects"],
      },
    });
    await $.tool.register({
      name: "RoomPost",
      description:
        "Post a short message to an izumo room you are in. Your project name is added automatically; don't prefix the text with it.",
      inputSchema: {
        type: "object",
        properties: {
          room: ROOM_PROP,
          text: { type: "string", description: "The message" },
          to: {
            ...PROJECTS,
            description: 'Projects (or "dylan") this is addressed to',
          },
          kind: {
            type: "string",
            enum: ["ask"],
            description: "Set when you need a reply or a decision",
          },
          answers: {
            type: "string",
            description: "The id of the ask this message answers",
          },
        },
        required: ["room", "text"],
      },
    });
    await $.tool.register({
      name: "RoomClose",
      description:
        "Close an izumo room this project owns. Nobody can post or join after that.",
      inputSchema: {
        type: "object",
        properties: { room: ROOM_PROP },
        required: ["room"],
      },
    });
    await $.command.register({
      name: "izumo",
      description: "Rooms shared with agents in other projects",
      argumentHint: "list [--all] | join <room> | leave <room> | close <room>",
    });
    await skipToEnd($);
    await acceptInvites($, await allRooms($), false);
    $.clock.every(POLL_MS, () => {
      if (isPolling) return;
      isPolling = true;
      void poll($).finally(() => {
        isPolling = false;
      });
    });
    return next(e);
  });

  on("classic.SessionStart", async ($, e, next) => {
    const answered = await next(e);
    if (e.source === "resume")
      await fillGap($, e.seconds_since_last_response ?? 0).catch((err: unknown) =>
        $.ui.toast(`izumo: couldn't catch up after resume: ${err instanceof Error ? err.message : String(err)}`),
      );
    return answered;
  });

  on("command.run", { command: "izumo" }, async ($, e) => ({
    text: await command($, e.args),
  }));

  const failed = {
    result: "izumo: the call failed partway; check /izumo list for what was written.",
    isError: true,
  } as const;
  on("tool.call", { tool: "mcp__izumo__RoomCreate" }, async ($, e) =>
    roomCreate($, e as unknown as ToolInput),
  ).catch(() => failed);
  on("tool.call", { tool: "mcp__izumo__RoomInvite" }, async ($, e) =>
    roomInvite($, e as unknown as ToolInput),
  ).catch(() => failed);
  on("tool.call", { tool: "mcp__izumo__RoomPost" }, async ($, e) =>
    roomPost($, e as unknown as ToolInput),
  ).catch(() => failed);
  on("tool.call", { tool: "mcp__izumo__RoomClose" }, async ($, e) =>
    roomClose($, e as unknown as ToolInput),
  ).catch(() => failed);

  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    const text = composeText(
      (await myRooms($)).map(({ room, state }) => ({
        room,
        owner: state.owner,
        openAsks: state.openAsks.length,
      })),
    );
    if (text === undefined) return composed;
    return {
      ...composed,
      sections: [
        ...composed.sections,
        { id: "izumo:rooms", text, scope: "session" as const },
      ],
    };
  });

  on("prompt.context", async ($, e, next) => {
    const context = await next(e);
    const text = catchUpText(await myRooms($), await $.clock.now());
    if (text === undefined) return context;
    return {
      ...context,
      blocks: [...context.blocks, { name: "izumoRooms", text }],
    };
  });
};
