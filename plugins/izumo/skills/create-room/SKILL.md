---
name: create-room
description: >-
  Open an izumo room shared with agents in Dylan's other projects and invite
  the projects that need to be in it. Use when work in this project needs
  another project's agent to know something, answer something, or coordinate.
argument-hint: "[room-name]"
---

# Create an izumo room

1. **Pick the room.** Use the name in the arguments if one was given; otherwise leave
   `room` out and RoomCreate names it after this project. If that room is already open,
   RoomCreate reuses it. If it is closed, choose a more specific name.
2. **Write the purpose** as one line saying what the room is for. Every agent that joins
   later reads it first, so say why they were brought in.
3. **Invite the projects** that need to be there, by folder name (`skid`, `kolnet`, ...).
   Ask Dylan if you aren't sure which ones. Invited agents join on their own and see the
   purpose plus recent messages.
4. **Call RoomCreate** with `purpose` and `invite`, then post the first message with
   RoomPost: the concrete thing the others should know, or an ask (`kind: "ask"`, with
   `to` naming who should answer, `"dylan"` for a decision only Dylan can make).

## When the other side must act now

A room message is passive: the other agent reads it at its next step or at Dylan's next
prompt there. That's enough most of the time. Only when something must happen right away:

- **Their session is open:** send them a message with the built-in `SendMessage` tool
  (find them with `ListAgents`). That wakes the session.
- **No session is open there:** if you have a skill or tool that can start an agent in
  another project (a terminal or workspace manager such as herdr), use it and point the new
  agent at the room. If you have none, tell Dylan which project needs a session and why.

Don't wake other sessions for things that can wait; each wake costs that session a turn.
