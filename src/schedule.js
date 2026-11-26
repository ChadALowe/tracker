// Tracking hours, worked out in UK time (or whichever zone the schedule names)
// so the start and end times stay put when the clocks change.

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };

export const DEFAULT_SCHEDULE = {
    timezone: "Europe/London",
    days: {
        mon: { on: true, start: "08:30", end: "16:30" },
        tue: { on: true, start: "08:30", end: "16:30" },
        wed: { on: true, start: "08:30", end: "16:30" },
        thu: { on: true, start: "08:30", end: "16:30" },
        fri: { on: true, start: "09:00", end: "16:00" },
        sat: { on: false, start: "09:00", end: "17:00" },
        sun: { on: false, start: "09:00", end: "17:00" }
    }
};

const formatters = new Map();
function formatter(tz) {
    if (!formatters.has(tz)) {
        formatters.set(tz, new Intl.DateTimeFormat("en-GB", {
            timeZone: tz, hourCycle: "h23", weekday: "short",
            year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
        }));
    }
    return formatters.get(tz);
}

// Wall-clock parts of `ms` in `tz`. `m` is 0-based, `dow` 0 = Sunday.
export function zonedParts(ms, tz) {
    const p = {};
    for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
    return { y: Number(p.year), m: Number(p.month) - 1, d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second), dow };
}

// How far `tz` is ahead of UTC at instant `ms`.
export function tzOffset(ms, tz) {
    const p = zonedParts(ms, tz);
    const asUtc = Date.UTC(p.y, p.m, p.d, p.h, p.mi, p.s);
    return asUtc - Math.floor(ms / 1000) * 1000;
}

// The instant when the wall clock in `tz` reads y-m-d h:mi.
export function zonedToUtc(y, m, d, h, mi, tz) {
    const guess = Date.UTC(y, m, d, h, mi);
    let ms = guess - tzOffset(guess, tz);
    ms = guess - tzOffset(ms, tz); // second pass settles clock-change days
    return ms;
}

export function parseHHMM(value) {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

function pad(n) { return String(n).padStart(2, "0"); }

// Today's (or a given day's) window as instants, or null when that day is off.
function windowOn(y, m, d, dow, schedule) {
    const day = schedule.days[DAY_KEYS[dow]];
    if (!day || !day.on) return null;
    const start = parseHHMM(day.start), end = parseHHMM(day.end);
    if (start === null || end === null || end <= start) return null;
    return {
        start: zonedToUtc(y, m, d, Math.floor(start / 60), start % 60, schedule.timezone),
        end: zonedToUtc(y, m, d, Math.floor(end / 60), end % 60, schedule.timezone)
    };
}

function addDays(y, m, d, n) {
    const t = new Date(Date.UTC(y, m, d + n));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), dow: t.getUTCDay() };
}

export function todaysWindow(ms, schedule) {
    const p = zonedParts(ms, schedule.timezone);
    return windowOn(p.y, p.m, p.d, p.dow, schedule);
}

export function isWithinSchedule(ms, schedule) {
    const w = todaysWindow(ms, schedule);
    return Boolean(w && ms >= w.start && ms < w.end);
}

// The next scheduled start after `ms`, looking up to 8 days ahead.
export function nextStart(ms, schedule) {
    const p = zonedParts(ms, schedule.timezone);
    for (let i = 0; i <= 8; i += 1) {
        const day = addDays(p.y, p.m, p.d, i);
        const w = windowOn(day.y, day.m, day.d, day.dow, schedule);
        if (w && w.start > ms) return w.start;
    }
    return null;
}

export function nextMidnight(ms, tz) {
    const p = zonedParts(ms, tz);
    const day = addDays(p.y, p.m, p.d, 1);
    return zonedToUtc(day.y, day.m, day.d, 0, 0, tz);
}

// Pressing Start: track until today's scheduled end if that's still ahead, otherwise until midnight.
export function manualStartUntil(ms, schedule) {
    const w = todaysWindow(ms, schedule);
    if (w && w.end > ms) return w.end;
    return nextMidnight(ms, schedule.timezone);
}

// Pressing Stop: pause until midnight; the schedule takes over again tomorrow.
export function manualStopUntil(ms, schedule) {
    return nextMidnight(ms, schedule.timezone);
}

// Should the Worker be checking right now, and why?
export function resolveState(ms, schedule, override) {
    const active = override && override.until && override.until > ms ? override : null;
    if (active && active.mode === "on") {
        return { live: true, reason: "manual", until: active.until, nextStart: null };
    }
    if (active && active.mode === "off") {
        return { live: false, reason: "paused", until: active.until, nextStart: nextStart(Math.max(ms, active.until - 1), schedule) };
    }
    const w = todaysWindow(ms, schedule);
    if (w && ms >= w.start && ms < w.end) {
        return { live: true, reason: "schedule", until: w.end, nextStart: null };
    }
    return { live: false, reason: "outside-hours", until: null, nextStart: nextStart(ms, schedule) };
}

// Clean up a schedule sent from the portal; throws with a readable message.
export function validateSchedule(input) {
    if (!input || typeof input !== "object" || !input.days) throw new Error("Schedule is missing its days.");
    const timezone = typeof input.timezone === "string" && input.timezone ? input.timezone : DEFAULT_SCHEDULE.timezone;
    try { formatter(timezone); } catch { throw new Error(`Unknown time zone: ${timezone}`); }
    const days = {};
    for (const key of DAY_KEYS) {
        const raw = input.days[key] || {};
        const on = Boolean(raw.on);
        const start = parseHHMM(raw.start), end = parseHHMM(raw.end);
        const fallback = DEFAULT_SCHEDULE.days[key];
        if (on && (start === null || end === null)) throw new Error(`Give ${DAY_NAMES[key]} a start and end time like 08:30.`);
        if (on && end <= start) throw new Error(`On ${DAY_NAMES[key]} the end time must be after the start time.`);
        days[key] = {
            on,
            start: start === null ? fallback.start : `${pad(Math.floor(start / 60))}:${pad(start % 60)}`,
            end: end === null ? fallback.end : `${pad(Math.floor(end / 60))}:${pad(end % 60)}`
        };
    }
    return { timezone, days };
}
