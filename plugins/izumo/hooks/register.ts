import type { EngineInterface as Engine, Register } from "claude-code";

import {
  catchUpText,
  composeText,
  formatMessage,
  parseCommand,
  projectName,
  readSince,
  recent,
  toLine,
} from "./rooms";

const POLL_MS = 5000;
const CATCH_UP = 20;
const TOOL = "RoomPost";

// How far this process has read each room: the text offset readSince continues from,
// and the file's byte size at that read, so an unchanged room costs one stat.
// A reload starts over and skips each room to its end.
const cursors = new Map<string, { offset: number; size: number }>();
// clock.every does not wait for an async callback, so a slow poll would overlap the next tick
let isPolling = false;

async function roomPath($: Engine, topic: string) {
  return `${await $.env.get("HOME")}/.claude/rooms/${topic}.jsonl`;
}

async function readRoom($: Engine, topic: string) {
  return $.fs.read(await roomPath($, topic)).catch(() => "");
}

async function roomSize($: Engine, topic: string) {
  return $.fs.stat(await roomPath($, topic)).then(
    (s) => s.size,
    () => 0,
  );
}

async function membersKey($: Engine) {
  return `rooms:${await $.session.root()}`;
}

async function joined($: Engine): Promise<string[]> {
  return (
    ((await $.store.get(await membersKey($))) as string[] | undefined) ?? []
  );
}

async function setJoined($: Engine, topics: string[]) {
  await $.store.set(await membersKey($), topics);
}

// Start a room at its current end, so joining never replays history into the chat.
async function skipToEnd($: Engine, topic: string) {
  const size = await roomSize($, topic);
  cursors.set(topic, { offset: (await readRoom($, topic)).length, size });
}

async function poll($: Engine) {
  const me = await $.session.id();
  for (const topic of await joined($)) {
    const cursor = cursors.get(topic);
    // joined by another session of this project since this one started
    if (cursor === undefined) {
      await skipToEnd($, topic);
      continue;
    }
    const size = await roomSize($, topic);
    if (size === cursor.size) continue;

    const read = readSince(await readRoom($, topic), cursor.offset);
    cursors.set(topic, { offset: read.offset, size });
    const fresh = read.messages.filter((m) => m.session !== me);
    for (const m of fresh)
      await $.session.append({
        message: {
          type: "user",
          content: [{ type: "text", text: formatMessage(topic, m) }],
        },
      });
    if (fresh.length > 0) $.ui.toast(`izumo: ${fresh.length} new in #${topic}`);
  }
}

async function post($: Engine, topic: string, text: string) {
  const line = toLine({
    ts: await $.clock.now(),
    project: projectName(await $.session.root()),
    session: await $.session.id(),
    text,
  });
  const path = await roomPath($, topic);
  await $.process.run(["mkdir", "-p", path.slice(0, path.lastIndexOf("/"))]);
  // O_APPEND through the shell so two sessions posting at once never overwrite each other;
  // the message goes in on stdin, never through shell parsing
  const { exitCode, stderr } = await $.process.run(
    ["sh", "-c", 'cat >> "$1"', "sh", path],
    {
      stdin: line,
    },
  );
  if (exitCode !== 0) throw new Error(`append to ${path} failed: ${stderr}`);
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description:
        "Post a short message to an izumo topic room you have joined, for agents in Dylan's other projects to read.",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Room name without #, e.g. payments",
          },
          text: { type: "string", description: "The message" },
        },
        required: ["topic", "text"],
      },
    });
    await $.command.register({
      name: "izumo",
      description: "Topic rooms shared with agents in other projects",
      argumentHint: "join <topic> | leave <topic> | list",
    });
    for (const topic of await joined($)) await skipToEnd($, topic);
    $.clock.every(POLL_MS, () => {
      if (isPolling) return;
      isPolling = true;
      void poll($).finally(() => {
        isPolling = false;
      });
    });
    return next(e);
  });

  on("command.run", { command: "izumo" }, async ($, e) => {
    const command = parseCommand(e.args);
    const topics = await joined($);
    switch (command.kind) {
      case "error":
        return { text: command.text };
      case "list":
        return {
          text: topics.length
            ? `izumo rooms: ${topics.map((t) => `#${t}`).join(", ")}`
            : "Not in any izumo room. /izumo join <topic>",
        };
      case "join":
        if (!topics.includes(command.topic))
          await setJoined($, [...topics, command.topic]);
        await skipToEnd($, command.topic);
        return { text: `Joined #${command.topic}` };
      case "leave":
        await setJoined(
          $,
          topics.filter((t) => t !== command.topic),
        );
        cursors.delete(command.topic);
        return { text: `Left #${command.topic}` };
    }
  });

  on("tool.call", { tool: "mcp__izumo__RoomPost" }, async ($, e) => {
    const { topic, text } = e as unknown as { topic: string; text: string };
    const topics = await joined($);
    if (!topics.includes(topic))
      return {
        result: `Not in #${topic}. Joined rooms: ${topics.map((t) => `#${t}`).join(", ") || "none"}.`,
        isError: true,
      };
    await post($, topic, text);
    return { result: `Posted to #${topic}` };
  }).catch(() => ({
    result: "izumo: RoomPost failed, nothing was posted.",
    isError: true,
  }));

  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    const text = composeText(await joined($));
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
    const rooms = [];
    for (const topic of await joined($))
      rooms.push({
        topic,
        messages: recent(await readRoom($, topic), CATCH_UP),
      });
    const text = catchUpText(rooms);
    if (text === undefined) return context;
    return {
      ...context,
      blocks: [...context.blocks, { name: "izumoRooms", text }],
    };
  });
};
