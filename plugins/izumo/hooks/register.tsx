import type { Elements, EngineInterface as Engine, Register } from "claude-code";

import {
  catchUpText,
  composeText,
  foldRoom,
  ago,
  humanFrom,
  formatMessage,
  isRoomName,
  logText,
  newId,
  parseCommand,
  parseEvents,
  projectColor,
  projectName,
  readSince,
  toLine,
  wakePrompt,
  wakeTargets,
  type MessageEvent,
  type RoomEvent,
  type RoomState,
} from "./rooms";
import { briefDigest, parseTranscript } from "./brief";
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
let isTurnRunning = false;
// The engine writes a response's blocks as rows while it streams, and a row appended between
// two of them (a server_tool_use and its result) splits the message: every later request is
// then refused with a 400. A poll that began just before a step still lands first, as a
// step's first block takes far longer to arrive than an append.
let isStepStreaming = false;
let isWakeQueued = false;
let turnDepth = 0;
// RoomAnswer writes as the user, so only a turn the user started may call it
let isHumanTurn = false;
// classic events carry it; a reload forgets it until the next prompt
let transcriptPath: string | undefined;
// the transcript outgrows $.fs's 4 MiB, and the brief only needs its recent end
const TAIL_BYTES = 4_000_000;

async function humanName($: Engine) {
  return humanFrom(await $.env.get("USER"));
}

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

const PANE = "izumo";
// The room the pane shows. Kept here rather than in $.state: a reload forgetting it only
// sends the pane back to its default room.
let paneRoom: string | undefined;
// messages run several lines each, so a fixed count and the pane's own scrolling
// read better than fitting the viewport row by row
const PANE_RECENT = 15;

type CardElements = Pick<Elements["terminal"], "Box" | "Text" | "Markdown">;

// One message as the pane draws it: a header (who, to whom, ask or reply, how long ago)
// and the body as Markdown, since agents write lists and code spans.
function messageCard({ Box, Text, Markdown }: CardElements, m: MessageEvent, now: number, human: string) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold color={projectColor(m.project, human)}>
          {m.project}
        </Text>
        {m.to?.length ? <Text dimColor>→ {m.to.join(", ")}</Text> : null}
        {m.kind === "ask" ? <Text color="warning">ask {m.id}</Text> : null}
        {m.answers !== undefined ? <Text color="success">re {m.answers}</Text> : null}
        <Text dimColor>· {ago(now - m.ts)}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Markdown text={m.text} />
      </Box>
    </Box>
  );
}

// The user writes as themselves: a session named after them matches no agent's session, so
// every member's poll delivers it, the session the user writes from included.
async function postAsHuman($: Engine, room: string, text: string, answers?: string) {
  const body = text.trim();
  if (!body) return;
  const ts = await $.clock.now();
  const human = await humanName($);
  // the user types no `to`; a line said to the room is for the agent that runs it, so it wakes the owner
  const owner = answers ? undefined : (await loadRoom($, room))?.owner;
  await write($, room, {
    type: "message",
    id: newId(ts),
    text: body,
    ...(answers ? { answers } : {}),
    ...(owner && owner !== human ? { to: [owner] } : {}),
    ts,
    project: human,
    session: human,
  });
  $.ui.invalidate("ui.render");
}

type BodyElements = CardElements & { Input?: Elements["terminal"]["Input"] };

// One room as the pane draws it under its tab. Mobile draws no Input: read-only there.
function roomBody(
  $: Engine,
  elements: BodyElements,
  room: string,
  state: RoomState,
  now: number,
  human: string,
  bodyColumns: number,
) {
  const { Box, Text, Input } = elements;
  const askIds = new Set(state.openAsks.map((m) => m.id));
  const recent = state.messages.filter((m) => !askIds.has(m.id)).slice(-PANE_RECENT);
  const canWrite = !state.isClosed && Input !== undefined;
  const meta = [
    ...(state.isClosed ? ["closed"] : []),
    `owner ${state.owner ?? "unknown"}`,
    state.members.join(", ") || "no members",
  ].join(" · ");

  return (
    <Box flexDirection="column">
      <Text bold>#{room}</Text>
      <Text dimColor>{meta}</Text>
      <Text dimColor italic>
        {state.purpose || "no purpose given"}
      </Text>

      {state.openAsks.length > 0 && (
        <Box key="asks" flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} marginTop={1}>
          <Text bold color="warning">
            Open asks ({state.openAsks.length})
          </Text>
          {state.openAsks.map((m, n) => (
            <Box flexDirection="column" marginTop={1}>
              {messageCard(elements, m, now, human)}
              {canWrite && Input && (
                <Box paddingLeft={2}>
                  <Input
                    key={`answer-${m.id}`}
                    autoFocus={n === 0 ? true : undefined}
                    placeholder={`Answer as ${human}`}
                    submitLabel="answer"
                    onSubmit={(value: string) => void postAsHuman($, room, value, m.id)}
                  />
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text bold>Recent</Text>
      </Box>
      {recent.length === 0 && <Text dimColor>No messages yet.</Text>}
      {recent.map((m) => (
        <Box flexDirection="column" marginTop={1}>
          {messageCard(elements, m, now, human)}
        </Box>
      ))}

      {canWrite && Input && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{"─".repeat(Math.max(10, Math.min(bodyColumns, 80)))}</Text>
          <Input
            key={`say-${room}`}
            autoFocus={state.openAsks.length === 0 ? true : undefined}
            placeholder={`Say as ${human}`}
            submitLabel="send"
            onSubmit={(value: string) => void postAsHuman($, room, value)}
          />
        </Box>
      )}
    </Box>
  );
}

// The pane's tabs: the open rooms this project is in, by name so they don't move around,
// then the room `/izumo show` named if it isn't one of them, as it is still worth reading.
async function paneTabs($: Engine): Promise<Room[]> {
  const project = await me($);
  const rooms = (await allRooms($)).sort((a, b) => a.room.localeCompare(b.room));
  const joined = rooms.filter(({ state }) => !state.isClosed && state.members.includes(project));
  const named = joined.some((r) => r.room === paneRoom) ? undefined : rooms.find((r) => r.room === paneRoom);
  return named ? [...joined, named] : joined;
}

// With no choice made yet, the room waiting on the user comes first.
const pickRoom = (tabs: readonly Room[], human: string) =>
  tabs.some((t) => t.room === paneRoom)
    ? paneRoom
    : (tabs.find(({ state }) => state.openAsks.some((a) => a.to?.includes(human))) ?? tabs[0])?.room;

function selectRoom($: Engine, room: string) {
  paneRoom = room;
  $.ui.invalidate("ui.render");
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
  human: string,
  fresh: readonly MessageEvent[],
) {
  const addressed = fresh
    .filter((m) => m.to?.includes(project))
    .map((m) => `${m.project} → you`);
  const forHuman = fresh.some((m) => m.kind === "ask" && m.to?.includes(human)) ? [`ask for ${human}`] : [];
  const notes = [...new Set([...addressed, ...forHuman])];
  return `izumo #${room}: ${fresh.length} new${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

// Starts a turn in this session for the messages addressed to it, once per poll at most.
// A running turn needs no prompt: its next step reads the rows just appended.
function wake($: Engine, rooms: { room: string; messages: MessageEvent[] }[]) {
  if (rooms.length === 0 || isTurnRunning || isWakeQueued) return;
  const depth = Math.max(...rooms.flatMap((r) => r.messages.map((m) => m.depth ?? 0))) + 1;
  isWakeQueued = true;
  // a plugin's own prompt never reaches its own prompt.submit hook, so the depth is set here,
  // when the call resolves: as the woken turn starts
  void $.prompt
    .submit({ text: wakePrompt(rooms) })
    .then(() => {
      turnDepth = depth;
      isHumanTurn = false;
    })
    .finally(() => {
      isWakeQueued = false;
    });
}

async function poll($: Engine) {
  const project = await me($);
  const mine = await $.session.id();
  const changed: Room[] = [];
  const toWake: { room: string; messages: MessageEvent[] }[] = [];
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
    const targets = wakeTargets(project, state, fresh, mine);
    if (targets.length > 0) toWake.push({ room, messages: targets });
    if (fresh.length > 0) $.ui.toast(toastFor(room, project, await humanName($), fresh));
    const closed = read.events.find((e) => e.type === "close");
    if (closed)
      await say($, `[#${room}] #${room} was closed by ${closed.project}.`);
  }
  await acceptInvites($, changed, true);
  wake($, toWake);
  // an open izumo pane reads its room fresh on every draw
  if (changed.length > 0) $.ui.invalidate("ui.render");
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
// Asked before the write so the wake score can ride on the message; never throws.
async function judge($: Engine, state: RoomState, message: MessageEvent) {
  try {
    const asks = message.answers === undefined ? state.openAsks : [];
    const needsKind = message.kind === undefined && message.answers === undefined;
    // an answer is what its asker waits on, so it always wakes and needs no judging
    const needsWake = (message.to?.length ?? 0) > 0 && message.answers === undefined;
    const request = buildQuestions(message, asks, needsKind, needsWake);
    const result = await askJev(request, {
      apiKey: await $.env.get("TYPESAFE_API_KEY"),
      fetch: (url, init) => $.http.fetch(url, init),
      timeout: () => $.clock.sleep(JEV_TIMEOUT_MS),
    });
    if ("skipped" in result) {
      const isQuiet = result.skipped === "TYPESAFE_API_KEY not set" || result.skipped === "nothing to ask";
      return { note: isQuiet ? "" : ` Jev check skipped: ${result.skipped}.` };
    }
    return { note: "", verdicts: jevVerdicts(result.answers, asks, JEV_THRESHOLD) };
  } catch (err) {
    return { note: ` Jev check failed: ${err instanceof Error ? err.message : String(err)}.` };
  }
}

// The message is already written, so a failure here must not read as "not posted".
async function applyVerdicts(
  $: Engine,
  room: string,
  message: MessageEvent,
  verdicts: ReturnType<typeof jevVerdicts>,
) {
  const notes: string[] = [];
  try {
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
  } catch (err) {
    notes.push(` Jev verdict not saved: ${err instanceof Error ? err.message : String(err)}.`);
  }
  return notes.join("");
}

const isAskIn = (state: RoomState, id: string) =>
  state.messages.some((m) => m.id === id && m.kind === "ask");

// Ask ids are unique across rooms, so an answer posted to the wrong room would leave the ask
// open where it lives and strand a reply nobody is waiting for.
async function misplacedAnswer($: Engine, room: string, id: string) {
  const home = (await allRooms($)).find(({ state }) => isAskIn(state, id));
  return home
    ? `Ask ${id} is in #${home.room}, not #${room}; post the answer there.`
    : `No ask ${id} in #${room}.`;
}

async function roomPost($: Engine, input: ToolInput): Promise<Answer> {
  const found = await memberRoom($, input.room);
  if ("error" in found) return { result: found.error!, isError: true };
  if (input.answers && !isAskIn(found.state, input.answers))
    return { result: await misplacedAnswer($, found.room, input.answers), isError: true };
  const at = await stamp($);
  const drafted: MessageEvent = {
    type: "message",
    id: newId(at.ts),
    text: input.text ?? "",
    ...(input.to?.length ? { to: input.to } : {}),
    ...(input.kind === "ask" ? { kind: "ask" as const } : {}),
    ...(input.answers ? { answers: input.answers } : {}),
    ...(turnDepth > 0 ? { depth: turnDepth } : {}),
    ...at,
  };
  const judged = await judge($, found.state, drafted);
  const fyi = judged.verdicts?.fyi;
  const message = fyi === undefined ? drafted : { ...drafted, fyi };
  await write($, found.room, message);
  const asAsk = message.kind === "ask" ? ` as ask ${message.id}` : "";
  const applied = judged.verdicts ? await applyVerdicts($, found.room, message, judged.verdicts) : "";
  return { result: `Posted to #${found.room}${asAsk}.${judged.note}${applied}` };
}

async function readTail($: Engine, path: string) {
  const { exitCode, stdout } = await $.process.run(["tail", "-c", String(TAIL_BYTES), path]);
  return exitCode === 0 ? stdout : "";
}

async function brief($: Engine): Promise<Answer> {
  const records = transcriptPath === undefined ? [] : parseTranscript(await readTail($, transcriptPath));
  return {
    result: briefDigest({ records, rooms: await allRooms($), human: await humanName($), now: await $.clock.now() }),
  };
}

async function roomAnswer($: Engine, input: ToolInput): Promise<Answer> {
  if (!isHumanTurn)
    return {
      result:
        "RoomAnswer posts as the user, so it works only in a turn the user started. Ask the user to answer in their own prompt, or in /izumo show <room>.",
      isError: true,
    };
  const room = input.room ?? "";
  const state = isRoomName(room) ? await loadRoom($, room) : undefined;
  if (state === undefined) return { result: `No room #${room}.`, isError: true };
  if (state.isClosed) return { result: `#${room} is closed.`, isError: true };
  if (!state.openAsks.some((m) => m.id === input.answers))
    return { result: `#${room} has no open ask ${input.answers}.`, isError: true };
  if (!input.text?.trim()) return { result: "The answer is empty.", isError: true };
  await postAsHuman($, room, input.text, input.answers);
  return { result: `Answered ask ${input.answers} in #${room} as ${await humanName($)}.` };
}

async function roomClose($: Engine, input: ToolInput): Promise<Answer> {
  const found = await memberRoom($, input.room);
  if ("error" in found) return { result: found.error!, isError: true };
  if (found.state.owner !== (await me($)))
    return {
      result: `Only #${found.room}'s owner (${found.state.owner}) or the user can close it.`,
      isError: true,
    };
  await write($, found.room, { type: "close", ...(await stamp($)) });
  return { result: `Closed #${found.room}.` };
}

async function command($: Engine, args: string) {
  const command = parseCommand(args);
  if (command.kind === "error") return command.text;
  if (command.kind === "list") return listText($, command.isAll);
  if (command.kind === "show") return show($, command.room);
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
      // the person typed it, so no owner check: the user can retire any room
      if (!state.isClosed)
        await write($, room, { type: "close", ...(await stamp($)) });
      return `Closed #${room}`;
    case "log":
      return logText(room, state, command.count);
  }
}

async function show($: Engine, room: string | undefined) {
  if (room !== undefined) {
    if ((await loadRoom($, room)) === undefined)
      return `No room #${room}. Rooms are created with /izumo:create-room.`;
    paneRoom = room;
  }
  const chosen = pickRoom(await paneTabs($), await humanName($));
  if (chosen === undefined) return "No rooms yet. Rooms are created with /izumo:create-room.";
  paneRoom = chosen;
  // the person asked for it to work in it, so it takes the keyboard
  await $.ui.open({ id: PANE, title: "izumo", focus: true });
  $.ui.invalidate("ui.render");
  return `Opened #${chosen}`;
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
    const human = await humanName($);
    await $.tool.register({
      name: "RoomCreate",
      description:
        "Create an izumo room shared with agents in the user's other projects, and invite projects to it. Only when three or more agents need to talk; between two sessions, message the other directly with SendMessage. The room defaults to this project's name; an open room with that name is reused.",
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
            description: `Projects (or "${human}", the user) this is addressed to`,
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
    await $.tool.register({
      name: "Brief",
      description:
        "For /izumo:brief: what the user missed since they last typed in this session (their open asks in every room, new room and peer messages, your replies, open questions). Read-only.",
      inputSchema: { type: "object", properties: {} },
    });
    await $.tool.register({
      name: "RoomAnswer",
      description: `Answer an open ask in an izumo room as the user (${human}), which closes it and wakes the asker. Only to relay a choice the user just made in this conversation, such as an AskUserQuestion pick; never to close an ask with another agent's answer or your own (use RoomPost with answers). Refused in any turn the user didn't start. You don't need to be in the room.`,
      inputSchema: {
        type: "object",
        properties: {
          room: ROOM_PROP,
          answers: { type: "string", description: "The id of the open ask" },
          text: { type: "string", description: "The user's decision, in their words where you have them" },
        },
        required: ["room", "answers", "text"],
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
      if (isPolling || isStepStreaming) return;
      isPolling = true;
      void poll($).finally(() => {
        isPolling = false;
      });
    });
    return next(e);
  });

  on("classic.SessionStart", async ($, e, next) => {
    transcriptPath = e.transcript_path ?? transcriptPath;
    const answered = await next(e);
    if (e.source === "resume")
      await fillGap($, e.seconds_since_last_response ?? 0).catch((err: unknown) =>
        $.ui.toast(`izumo: couldn't catch up after resume: ${err instanceof Error ? err.message : String(err)}`),
      );
    return answered;
  });

  on("prompt.submit", ($, e, next) => {
    // anyone else's prompt (the person, the SDK, another plugin) starts a chain afresh;
    // izumo's own wake never arrives here and sets its depth in wake()
    turnDepth = 0;
    isHumanTurn = e.origin?.kind === "composer" || e.origin?.kind === "bridge";
    return next(e);
  });

  on("classic.UserPromptSubmit", ($, e, next) => {
    transcriptPath = e.transcript_path ?? transcriptPath;
    return next(e);
  });

  on("turn.start", ($, e, next) => {
    isTurnRunning = true;
    return next(e);
  });

  on("turn.complete", ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false;
      isStepStreaming = false;
    }
    return next(e);
  });

  // a subagent's response streams into its own transcript, not this conversation
  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e);
    isStepStreaming = true;
    try {
      return yield* next(e);
    } finally {
      isStepStreaming = false;
    }
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
  on("tool.call", { tool: "mcp__izumo__Brief" }, async ($) => brief($)).catch(() => ({
    result: "izumo: couldn't read the transcript or the rooms; brief from your own context.",
    isError: true as const,
  }));
  on("tool.call", { tool: "mcp__izumo__RoomAnswer" }, async ($, e) =>
    roomAnswer($, e as unknown as ToolInput),
  ).catch(() => failed);

  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    const text = composeText(
      (await myRooms($)).map(({ room, state }) => ({
        room,
        owner: state.owner,
        purpose: state.purpose,
        openAsks: state.openAsks.length,
      })),
      await humanName($),
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

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const elements = $.ui.resolve(e);
    const { Box, Text, Button } = elements;
    const human = await humanName($);
    const tabs = await paneTabs($);
    const room = pickRoom(tabs, human);
    const state = tabs.find((t) => t.room === room)?.state;
    if (room === undefined || state === undefined) return <Text dimColor>No rooms yet.</Text>;
    const Input = "Input" in elements ? elements.Input : undefined;

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {tabs.map((t) => (
            <Button
              key={`tab-${t.room}`}
              variant={t.room === room ? "primary" : undefined}
              onPress={() => selectRoom($, t.room)}
            >
              #{t.room}
              {t.state.openAsks.length > 0 ? <Text color="warning">{` ${t.state.openAsks.length}`}</Text> : null}
            </Button>
          ))}
        </Box>
        <Box marginTop={1}>
          {roomBody($, { ...elements, Input }, room, state, await $.clock.now(), human, e.props.bodyColumns)}
        </Box>
      </Box>
    );
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
