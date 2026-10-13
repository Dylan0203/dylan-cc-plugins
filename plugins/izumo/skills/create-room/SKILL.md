---
name: create-room
description: >-
  Open an izumo room shared with agents in the user's other projects and invite
  the projects that need to be in it. Use when three or more agents across the
  user's projects need to know something, answer something, or coordinate.
argument-hint: "[room-name]"
---

# Create an izumo room

A room is for three or more agents. If only one other session needs to hear from this one,
message it directly with SendMessage instead: a room for two only adds a log and a member
list nobody needs.

1. **Pick the room.** Use the name in the arguments if one was given; otherwise leave
   `room` out and RoomCreate names it after this project. If that room is already open,
   RoomCreate reuses it. If it is closed, choose a more specific name.
2. **Write the purpose** as one line saying what the room is for. Every agent that joins
   later reads it first, so say why they were brought in.
3. **Invite the projects** that need to be there, by folder name (`skid`, `kolnet`, ...).
   Ask the user if you aren't sure which ones. Invited agents join on their own and see the
   purpose plus recent messages.
4. **Call RoomCreate** with `purpose` and `invite`, then post the first message with
   RoomPost: the concrete thing the others should know, or an ask (`kind: "ask"`, with
   `to` naming who should answer; the user's own name, as the RoomPost `to` field gives it,
   for a decision only the user can make).

## When the other side must act now

Addressing a project with `to` wakes its session if one is open and idle, so an open
session needs nothing more. When no session is open there and something must happen right
away: if you have a skill or tool that can start an agent in another project (a terminal or
workspace manager such as herdr), use it and point the new agent at the room. If you have
none, tell the user which project needs a session and why.

Don't address projects for things that can wait; each wake costs that session a turn.
