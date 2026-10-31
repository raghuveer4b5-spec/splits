---
name: setup
description: Setup questionnaire for Headroom. Checks the user's Garmin data, asks about the morning check (time, notifications, max HR) and their training (goal, runs per week, long-run day, strength days, priority), then saves ~/.headroom/config.json, builds a weekly run plan around their strength training, and schedules the morning check. Use when the user installs Headroom, asks to set it up, or wants to change their schedule, notifications, max HR or training plan.
---

# Headroom setup

Two short rounds of questions, then a saved config, a weekly plan, a scheduled morning check, and one test run. Re-running setup updates the existing config and schedule instead of adding a second one; keep answers the user doesn't change.

## 0. The Garmin API key

Headroom reads Garmin through the official Personal API with the user's own key, saved in `~/.headroom/garmin.key`. Check it exists without reading it: `test -s ~/.headroom/garmin.key && echo yes || echo no`.

If there's no key, walk the user through it:

1. In Garmin Connect on the web, open https://connect.garmin.com/app/settings/personalApiToken, select **Create Key**, accept the terms and pick an expiry (one year means the fewest renewals). Garmin shows the key once, so copy it.
2. Save it. On a Mac, with the key still copied, they run this in their own terminal (Terminal, or a terminal tab beside this chat; a `!` command typed into the chat box can't read input):
   `mkdir -p ~/.headroom && pbpaste > ~/.headroom/garmin.key && chmod 600 ~/.headroom/garmin.key && echo Saved`
   Elsewhere: save it as the only line of `~/.headroom/garmin.key` in a text editor.
3. Check it again with the `test -s` command above.

Never ask for the key in chat, and never print, read or echo the file. If the user pastes a key into the chat anyway, don't use or repeat it: tell them it's now in the chat transcript, and ask them to delete that key on the same Garmin page and save a new one.

If the user doesn't want a key, Headroom works through Claude in Chrome instead (step 1, Chrome path).

## 1. Check the data

**With a key:** from the plugin root (two levels up from this skill's directory), run `node tools/check.js --profile`. If it returns `key-invalid`, the key was mistyped, deleted or has expired: go back to step 0.

**Chrome path:** follow steps 1-3 of the morning check's Chrome path in the `headroom:readiness` skill (fresh Chrome tab on `https://connect.garmin.com/app/home`, user signed in). Then run one `javascript_tool` call with the full contents of `../readiness/scripts/headroom-garmin.js` (relative to this skill's directory), a new line, and `Headroom.start('profile')`, then collect it with `Headroom.result()` as in step 5 of the morning check. Keep the tab open for the test run in step 6.

Either way, it returns `estimatedTimes` (current 5K, 10K and half-marathon times estimated from the best recent run), `weeklyRunKm4w` (average running km per week, last 4 weeks), `longestRunKm4w`, `usualLiftDays` (weekdays with 2+ strength sessions in the last 4 weeks), `observedMaxHr`, `daysWithHrv` and `readyToScore`. If `readyToScore` is false, tell the user the score needs about 14 nights of HRV data from wearing the watch overnight; setup can continue now.

## 2. Ask the questions

Use AskUserQuestion when available (up to 4 questions per call). Pre-fill from the profile where you can.

**Round 1: the morning check**
1. **Time.** 06:30, 07:00, 07:30, 08:00. It needs the computer awake (with Chrome open on the Chrome path), and the watch synced through the phone.
2. **Notifications.** Every morning (recommended); only on Low or Poor days; no notifications, just the log.
3. **Delivery.** Email (recommended: the most reliable, since scheduled runs can't always push to a phone), push notification, or both. For email, confirm the address to send to; only ever use an address the user gives or confirms here.
4. **Max heart rate.** Offer "{observedMaxHr} bpm, the highest in your last 90 days" (when there is one), "I don't know: estimate it from my age", and Other for a tested or Garmin-set value. If they don't know, ask their age (Other, a number) and use `208 - 0.7 x age`, rounded (Tanaka et al., 2001: the least biased of the common formulas, typically within about 10 bpm). Recommend the higher of the observed and age values: an observed max is a floor, since easy running rarely reaches it. If the observed value is more than 15 bpm above the age estimate, mention it may be a wrist-sensor spike and ask which to use.

**First, which plan.** Ask: **"How long can you run without stopping right now?"** Options: not yet, or under a minute; about 2-4 minutes; about 5-10 minutes; 20 minutes or more, or a 5K. The last option goes to the regular plan (Round 2 below). Anything shorter goes to **beginner mode**:

- Map the answer to `canRun`: `none`, `3min`, `5min`, `10min` (if they typed a time between 10 and 20 minutes in Other).
- Ask **"Any running or leg injury in the last 12 months?"** (yes / no). If yes, set `injuryHistory: true`: they start one stage lower, and a single low-readiness morning is enough to repeat a stage. Suggest a physio check before starting if anything still hurts.
- Ask runs per week (2 or 3; recommend 3), the long-run day (used to spread sessions), strength days and priority, as in Round 2. Skip goal and times: the goal is 30 minutes non-stop, and paces come later.
- Explain briefly: 14 stages of run/walk, moving up only when the last week went well. Most people repeat a stage now and then, and that's the point. After 30 minutes non-stop, setup runs again to switch to the regular plan with paces.

**Round 2: training** (regular plan)
1. **Goal.** 5K, 10K, half marathon, or general fitness.
2. **Runs per week.** 2, 3, 4 or 5. Mention their recent volume ({weeklyRunKm4w} km/week) so they pick something realistic.
3. **Long-run day.** Saturday, Sunday, Friday, or another day via Other.
4. **Strength days and priority.** Say which days Garmin shows they usually lift ({usualLiftDays}), and ask what comes first: running, strength training, or balanced. They can correct the days in Other.

**Round 3: times** (skip for general fitness unless the user wants paces)
1. **Current time** at the goal distance. Offer the profile's `estimatedTimes` value first ("about 27:03, from your best recent run"), plus "a recent race time" and "I don't know" (no paces then; the plan uses heart rate and effort only). This sets the training paces, so it must be what they can run now, not what they hope for.
2. **Goal time.** Offer three sensible targets: roughly 2%, 4% and 6% faster than the current time, rounded to the nearest 30 seconds for 5K and 10K, or the nearest minute for the half. Mention that 4-6% over two to three months is a realistic stretch for a newer runner.

Strength training is a black box: ask only which days, never what the sessions train, and never prescribe lifts. The plan schedules runs around those days and adds two short bodyweight runner-strength blocks a week.

## 3. Save the config

Write `~/.headroom/config.json` (create the folder if needed):

```json
{
  "version": 1,
  "morningTime": "07:30",
  "notify": "daily",
  "email": "you@example.com",
  "push": true,
  "maxHr": 190,
  "plan": {
    "goal": "5k",
    "runsPerWeek": 4,
    "longRunDay": "sun",
    "liftDays": ["mon", "wed", "fri"],
    "priority": "balanced",
    "startDate": "2026-10-19",
    "baseWeeklyKm": 9.5,
    "baseLongKm": 8,
    "currentTime": "29:30",
    "goalTime": "28:30"
  },
  "updatedAt": "2026-10-22"
}
```

- `maxHr` is the value the user chose. When it came from their age, also save `"age"` and `"maxHrSource": "age"`, so a later setup can offer the observed value once real hard efforts show up.
- `notify`: `daily`, `low-and-poor` or `none`. `email` is omitted and `push` is `false` when the user didn't choose that channel.
- Days are lowercase three-letter weekdays.
- `startDate` is the Monday of the current week; week numbers and the 10%-a-week build count from it. Keep the existing `startDate` when re-running setup unless the goal changed.
- `baseWeeklyKm` is `weeklyRunKm4w` and `baseLongKm` is `longestRunKm4w` from the profile.
- Beginner plans use `"mode": "beginner"`, `"stage"` from the starting-stage rule (`none` 1, `3min` 4, `5min` 6, `10min` 9; one lower with `injuryHistory`), `"injuryHistory"`, `runsPerWeek`, `longRunDay`, `liftDays`, `priority` and `startDate`, with no times. The Sunday job moves `stage` forward.
- `currentTime` and `goalTime` are race times at the goal distance (`mm:ss`, or `h:mm:ss` for the half). Omit `currentTime` if the user doesn't know it. Paces in every session come from `currentTime`; when the user runs a faster race, update it so the paces move with them.

## 4. Show the plan

Run `node tools/plan.js` from the plugin root (or, on the Chrome path, `Headroom.planWeek({ config: <the config object> })` in the same tab) and show the week to the user as a short table (day, run, strength). Mention any `note:` lines. Ask if they want to change anything before scheduling.

## 5. Schedule the morning check

Use the scheduled-task tool available in this app to create, or update if it already exists, a daily task named **Headroom morning check** at `morningTime`, in the user's local time zone, with this prompt:

> Scheduled run: use the headroom:readiness skill to run my morning check. Follow the notify setting in ~/.headroom/config.json. Don't ask for feedback.

If the user chose email delivery and has a plan, also create (or update) a weekly task named **Headroom weekly plan** for Sunday at 19:00 local time, with this prompt:

> Scheduled run: use the headroom:readiness skill to send my weekly plan email. Don't ask for feedback.

If no scheduling tool is available, say so, and tell the user they can ask Claude for "my readiness" each morning instead.

Scheduled runs are unattended, so any permission prompt stops them. Tell the user to open the task and click **Run now** once while at the computer, and to allow `node tools/check.js` when asked (and, on the Chrome path, "always allow" for connect.garmin.com in Claude in Chrome). Push notifications only reach their phone while Remote Control is on.

## 6. Test run

Run the morning check once now with the new config (`headroom:readiness` skill), so the user sees exactly what the morning notification says, including today's workout. Then confirm the setup in two or three lines: time, notification rule, plan summary.
