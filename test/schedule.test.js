import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCHEDULE as S, resolveState, isWithinSchedule, nextStart, manualStartUntil, manualStopUntil, validateSchedule } from "../src/schedule.js";

const at = (iso) => Date.parse(iso);

test("winter (GMT) weekday hours", () => {
    // Thu 26 Nov 2026 — GMT
    assert.equal(isWithinSchedule(at("2026-11-26T08:29:00Z"), S), false);
    assert.equal(isWithinSchedule(at("2026-11-26T08:30:00Z"), S), true);
    assert.equal(isWithinSchedule(at("2026-11-26T16:29:59Z"), S), true);
    assert.equal(isWithinSchedule(at("2026-11-26T16:30:00Z"), S), false);
});

test("summer (BST) hours follow UK clock", () => {
    // Mon 15 Jun 2026 — BST, 08:30 UK = 07:30 UTC
    assert.equal(isWithinSchedule(at("2026-06-15T07:29:00Z"), S), false);
    assert.equal(isWithinSchedule(at("2026-06-15T07:30:00Z"), S), true);
    assert.equal(isWithinSchedule(at("2026-06-15T15:30:00Z"), S), false);
});

test("Friday is 09:00–16:00, weekends off", () => {
    assert.equal(isWithinSchedule(at("2026-11-27T08:45:00Z"), S), false);
    assert.equal(isWithinSchedule(at("2026-11-27T09:00:00Z"), S), true);
    assert.equal(isWithinSchedule(at("2026-11-27T16:00:00Z"), S), false);
    assert.equal(isWithinSchedule(at("2026-11-28T12:00:00Z"), S), false);
    assert.equal(nextStart(at("2026-11-27T17:00:00Z"), S), at("2026-11-30T08:30:00Z"));
});

test("clock change weekend: Monday after spring forward starts 07:30 UTC", () => {
    // Clocks go forward Sun 29 Mar 2026
    assert.equal(nextStart(at("2026-03-27T17:00:00Z"), S), at("2026-03-30T07:30:00Z"));
});

test("manual start runs to today's end; stop pauses till midnight", () => {
    const early = at("2026-11-26T07:00:00Z");
    assert.equal(manualStartUntil(early, S), at("2026-11-26T16:30:00Z"));
    assert.equal(manualStartUntil(at("2026-11-26T18:00:00Z"), S), at("2026-11-27T00:00:00Z"));
    assert.equal(manualStopUntil(at("2026-06-15T10:00:00Z"), S), at("2026-06-15T23:00:00Z")); // BST midnight

    const on = resolveState(early, S, { mode: "on", until: manualStartUntil(early, S) });
    assert.equal(on.live, true);
    const off = resolveState(at("2026-11-26T10:00:00Z"), S, { mode: "off", until: at("2026-11-27T00:00:00Z") });
    assert.equal(off.live, false);
    assert.equal(off.nextStart, at("2026-11-27T09:00:00Z"));
    // expired override is ignored
    assert.equal(resolveState(at("2026-11-27T10:00:00Z"), S, { mode: "off", until: at("2026-11-27T00:00:00Z") }).live, true);
});

test("validation", () => {
    assert.throws(() => validateSchedule({ days: { mon: { on: true, start: "17:00", end: "09:00" } } }));
    assert.throws(() => validateSchedule({ days: { mon: { on: true, start: "nine", end: "17:00" } } }));
    const v = validateSchedule({ days: { mon: { on: true, start: "8:05", end: "17:00" } } });
    assert.equal(v.days.mon.start, "08:05");
    assert.equal(v.days.tue.on, false);
});
