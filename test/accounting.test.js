import test from "node:test";
import assert from "node:assert/strict";
import { newRecord, applyPresence, applyError, closeInterval } from "../src/accounting.js";

const M = 60000;
const user = { id: "u1", displayName: "Sam" };

test("worked example from the portal: 45 min available of 60", () => {
    const rec = newRecord(user);
    const t0 = Date.parse("2026-11-26T09:00:00Z");
    for (let m = 0; m <= 60; m += 1) {
        const av = m >= 20 && m < 30 ? "Away" : "Available";
        applyPresence(rec, user, { availability: av, activity: av }, t0 + m * M);
    }
    closeInterval(rec, t0 + 60 * M, false);
    let online = 0, available = 0;
    for (const s of rec.segments) {
        online += s.e - s.s;
        if (s.st === "Available" && !s.adj) available += s.e - s.s;
    }
    assert.equal(online / M, 60);
    assert.equal(available / M, 45);
});

test("gaps longer than 3 minutes aren't counted; errors close the interval", () => {
    const rec = newRecord(user);
    const t0 = 1_000_000_000_000;
    applyPresence(rec, user, { availability: "Busy" }, t0);
    applyPresence(rec, user, { availability: "Busy" }, t0 + 10 * M);
    assert.equal(rec.segments.length, 0);
    applyPresence(rec, user, { availability: "Busy" }, t0 + 11 * M);
    assert.equal(rec.segments[0].e - rec.segments[0].s, M);
    applyError(rec, user, "boom", t0 + 12 * M);
    assert.equal(rec.openSince, null);
    assert.equal(rec.segments[0].e, t0 + 12 * M);
});
