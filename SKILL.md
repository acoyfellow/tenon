---
name: tenon
description: Check an owner-keyed Cloudflare agent app against the nine tenon rules (identity, owner state, payer, secrets, origin, isolate, runs, versions, public pages) and turn each gap into a fix task with a proof command. Use before shipping or reviewing coil, hark, my-ax, chat-ax, skin, or any new app of the same shape.
---

# tenon

## When to use

- You change auth, Durable Object routing, model routing, agent code execution, run state, or versioning in an agent app.
- You review one of these apps, or start a new app of the same shape.

## Run the check

```sh
cd ~/cloudflare
node basic/kernel/run.mjs --app=<coil|hark|my-ax|chat-ax|skin|tenon>
```

This writes `basic/reports/kernel-<app>.md` for people and `basic/reports/kernel-<app>.json` for agents.

## Read the result

- `has`: a strong probe matched. Read the cited line before you trust it.
- `partial`: only weak probes matched. Treat as a gap.
- `missing`: nothing matched. Treat as a gap.
- `n/a`: the app opts out on purpose. The reason is in `basic/kernel/optouts.json`.

Fix `missing` before `partial`. Never mark a rule done from a probe match alone.

## Fix a gap

Each gap in `kernel-<app>.json` has a `fix` object:

- `change`: what to do, in one sentence.
- `near`: the file and line to start from.
- `reference`: the tenon line that does it right. Copy the shape, not the code.
- `tests`: the tenon security tests for this rule. Write the same test in the app.
- `proof`: a command that exits 0 only when the rule is `has`. Run it after the fix.

One gap is one task. Do not batch rules in one change.

## Rules

The nine rules live in `tenon/invariants.json`. That file is the only source. Do not copy rule text into other files.

## Limits

- Probes are static. A `has` does not prove the behavior. The tenon tests do, for tenon only.
- Opt-outs need a reason a reviewer would accept.
