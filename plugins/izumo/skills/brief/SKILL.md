---
name: brief
description: >-
  Dig out what needs the user since they last typed: asks addressed to them in
  every izumo room, what the rooms and peer sessions said, and questions you
  raised that are still open. Reports first, then asks each open decision as a
  menu and acts on the picks. Use when the user runs /izumo:brief or asks what
  is waiting on them.
---

# /izumo:brief

The user works with many agents at once. Between their prompts, rooms and peer sessions
fill up, and the two or three things that actually need **them** end up buried in
scrollback. This brief digs them back out.

**Dense, not long.** The reporting earns its length; the rest does not. If the user has to
scroll past state and progress to reach the decisions, the order is wrong. The decisions
come as a menu they can click, never as prose they have to answer by reference.

Write the brief in the user's language.

## Step 1: pull the raw material

Call the izumo **Brief** tool. It returns, from this session's transcript and every room:

- `LAST_PROMPT` / `LAST_PROMPT_AT`: the last thing the user actually typed (slash
  commands, compaction summaries, peer messages and izumo's own rows are not counted).
  `WINDOW_TRUNCATED` instead means it could not see that far back: lean on your own
  context for what came before.
- `OPEN ASKS FOR <user>`: every ask addressed to the user that is still open, in any open
  room, with room, ask id, who asked and how long it has waited.
- `ROOM MESSAGES SINCE`: what the open rooms this project is in said since that prompt.
- `PEER MESSAGES SINCE`: messages other Claude sessions sent this one (subagent hand-backs
  excluded).
- `MY REPLIES SINCE`: what you said after that prompt.
- `DECISION CANDIDATES`: paragraphs from the last three prompts' worth of your replies that
  ask something, each tagged `replied after` or `no reply yet`.

If Brief is missing or fails, brief from your own context and say so in one line.

## Step 2: decide what's still open

**Room asks first.** An open ask addressed to the user is open by definition: it closes
only when someone answers it. Those are the backbone of the menu.

**The session fills the gaps.** The candidates are guesses, not answers. For each:

- the user replied after it and the reply settled it → drop it
- overtaken by events (the thing it was about already shipped) → drop it
- still open → keep it

If a candidate and a room ask are the same decision, keep the room ask and drop the
candidate, so the user is asked once. **Read your own context too**: a decision you raised
without a question mark won't be in the candidates.

If nothing is open, say exactly that in one line and stop. An empty brief is a good brief.

## Step 3: report what happened, then ask as a menu

Four parts, in this order. The reporting comes **first**: decisions without their context
are as unanswerable as context without decisions.

### 3a. What the rooms and sessions said

**This is the part the user cannot get anywhere else.** Peers and rooms talk to agents,
not to them. Do not compress it into "X finished Y". Lead with what a reader who was away
needs:

- **findings that changed the picture**: a premise that turned out false, a risk ruled
  out, a number that moved
- **corrections**, yours or theirs. If a peer proved you wrong, say so plainly; that is
  higher-signal than any completion notice
- **things that cost real effort to learn**: a version-dependent behaviour, a measurement
  trap, a masked second failure
- completions, last, one line each

Group by room or session. Roughly one to three bullets each, eight or so in total; if more
happened, keep the ones a reader would be annoyed to discover later and say how many
routine updates you dropped. Silence is information too: a room or session that has been
quiet gets one line saying so.

```
📥 Rooms and sessions
   #payments · kolnet, skid
     · the failing check was the lockfile format, not the network; retry no longer needed
   skid · idle
     · added the --immutable check CI actually runs; it was missing before
```

### 3b. Progress and blockers, short

```
▶ Moving
   · <one line each, newest first>

⏸ Blocked
   · <what · on whom>
```

No SHAs unless the user needs one to act. A blocker always names who: a peer session, an
external service, or the user. Drop either heading if it is empty.

### 3c. Ask the open decisions with AskUserQuestion

This is the point of the brief: the user picks from a menu instead of typing back a
reference to something in scrollback. Never render the decisions as a numbered list in
prose.

- `question`: the decision in one line, ending in a question mark, with the pressure in
  it: how long it has waited and what it blocks, e.g. `Move the other five packages too?
  (asked 3 days ago in #payments, blocks nothing)`
- `header`: at most 12 characters, the subject only
- `options`: 2 or 3 real ones. **The recommended one goes first, marked as recommended.**
  `description` carries the one-line reason. Never write an "Other" option; the harness
  adds it. With no real preference, say so in the first option's description rather than
  faking one.
- `multiSelect`: `false` for a pick-one; `true` only when the choices genuinely combine

At most 4 questions per call and 4 options each. With more than four open decisions, ask
the four that block the most and name the rest in one line so they aren't lost. **Order
by what's blocking**: chain-blockers first, "blocks nothing" last.

### 3d. Act on the picks

Until the user picks, the brief is read-only: no fixes, no dispatching, no messages. Once
they pick, their picks are decisions, not discussion. Apply them as if they had typed them:

- **A room ask**: call **RoomAnswer** with the room, the ask id and the decision, in the
  user's words where you have them. That closes the ask and wakes the asker. Only ever
  relay what the user picked; never answer for them.
- **Anything else**: do the work, or message the peer that was waiting.

If a pick needs one more detail before you can act, ask that one thing; don't reopen the
whole menu.

### 3e. Standing policy: offer an ADR, don't write one

Most answers are operational (which PR first, deploy order) and belong nowhere but the
chat. A few are **standing policy**: they will be re-litigated months later by someone who
wasn't here. Test: *would a competent person reopen this without knowing the reasoning?*

If an answer passes that test, say so in one line and offer to record it as an ADR in the
repository the policy governs, through whatever ADR skill the user has. Never write the
record from inside the brief.

## Step 4: offer nothing else

End after the brief. No summary of the summary, no "shall I continue": the user will say.

## Why this exists

The brief is a net, not the fix. The fix is putting every decision for the user into a room
as an ask addressed to them, or ending every turn with a clear "waiting on you" block, so
nothing needs digging out later. When that habit holds, most briefs come back nearly
empty, and that is success.
