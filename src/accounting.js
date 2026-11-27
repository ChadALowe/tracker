// Time accounting, moved from the page so the Worker can run it.
// The rules are unchanged: see "How it's calculated" in the portal.
//
// A record is { userId, userLabel, availability, activity, checkedAt,
// firstSeenAt, openSince, segments }. `segments` only needs to hold the
// most recent few segments (the "tail"): nothing here reaches further back
// than the 5-minute Away adjustment.

export const AWAY_OFFSET_MS = 5 * 60 * 1000;
export const POLL_MS = 60 * 1000;
export const GAP_LIMIT_MS = Math.max(2 * POLL_MS, 3 * 60 * 1000);

const lower = (v) => String(v || "").toLowerCase();

// Busy (in a call or meeting) counts as available. Busy (idle) and Do not disturb don't.
export function isAvailableStatus(av) { const a = lower(av); return a === "available" || a === "busy"; }
export function isErrorStatus(av) { return lower(av) === "error"; }
export function isOfflineStatus(av) { const a = lower(av); return a === "" || a === "offline" || a === "presenceunknown"; }
export function isCountedStatus(av) { return !isOfflineStatus(av) && !isErrorStatus(av); }
export function isInactivityDrivenStatus(av, act) {
    const a = lower(av);
    return a === "away" || a.includes("idle") || lower(act) === "inactive";
}

export function userLabel(user) {
    return user.displayName || user.userPrincipalName || user.mail || user.id;
}

export function newRecord(user) {
    return {
        userId: user.id, userLabel: userLabel(user), availability: null, activity: null,
        checkedAt: null, firstSeenAt: null, openSince: null, segments: []
    };
}

export function appendSegment(rec, s, e, st, adj = false) {
    const last = rec.segments[rec.segments.length - 1];
    if (last && last.e === s && last.st === st && Boolean(last.adj) === adj) {
        last.e = e;
    } else {
        const seg = { s, e, st };
        if (adj) seg.adj = true;
        rec.segments.push(seg);
    }
}

// Credit the time since the last check to the status seen at that check.
export function closeInterval(rec, untilMs, keepOpen) {
    if (rec.openSince) {
        const elapsed = untilMs - rec.openSince;
        if (elapsed > 0 && elapsed <= GAP_LIMIT_MS && isCountedStatus(rec.availability)) {
            appendSegment(rec, rec.openSince, untilMs, rec.availability);
        }
    }
    rec.openSince = keepOpen ? untilMs : null;
}

// Re-label the last few minutes of an unbroken Available stretch ending at `atMs`.
export function applyAwayAdjustment(rec, atMs) {
    const segs = rec.segments;
    let remaining = AWAY_OFFSET_MS;
    let cursor = atMs;
    let applied = 0;
    let i = segs.length - 1;
    while (remaining > 0 && i >= 0) {
        const seg = segs[i];
        if (seg.e !== cursor || !isAvailableStatus(seg.st) || seg.adj) break;
        const take = Math.min(remaining, seg.e - seg.s);
        const splitAt = seg.e - take;
        const adjSeg = { s: splitAt, e: seg.e, st: "Away", adj: true };
        if (splitAt === seg.s) {
            segs.splice(i, 1, adjSeg);
        } else {
            seg.e = splitAt;
            segs.splice(i + 1, 0, adjSeg);
        }
        remaining -= take;
        applied += take;
        cursor = splitAt;
        i -= 1;
    }
    for (let j = segs.length - 1; j > 0; j -= 1) {
        const a = segs[j - 1], b = segs[j];
        if (a.adj && b.adj && a.e === b.s) {
            a.e = b.e;
            segs.splice(j, 1);
        }
    }
    return applied;
}

// Returns a log entry when the status changed, otherwise null.
export function applyPresence(rec, user, presence, nowMs) {
    closeInterval(rec, nowMs, true);

    const prevAv = rec.availability;
    const newAv = presence.availability || "PresenceUnknown";
    const newAct = presence.activity || "";
    let log = null;

    if (prevAv && !isErrorStatus(prevAv) && prevAv !== newAv) {
        log = { ts: nowMs, userId: user.id, userLabel: userLabel(user), fromAvailability: prevAv, toAvailability: newAv, activity: newAct };
    }

    if (isAvailableStatus(prevAv) && !isAvailableStatus(newAv) && isCountedStatus(newAv) && isInactivityDrivenStatus(newAv, newAct)) {
        applyAwayAdjustment(rec, nowMs);
    }

    rec.userLabel = userLabel(user);
    rec.availability = newAv;
    rec.activity = newAct;
    rec.checkedAt = nowMs;
    if (!rec.firstSeenAt) rec.firstSeenAt = nowMs;
    return log;
}

export function applyError(rec, user, message, nowMs) {
    closeInterval(rec, nowMs, false);
    rec.userLabel = userLabel(user);
    rec.availability = "Error";
    rec.activity = message;
    rec.checkedAt = nowMs;
}
