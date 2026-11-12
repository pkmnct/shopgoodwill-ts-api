import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  shopgoodwillTimeToDate,
  wallClockToDate,
} from "./ShopgoodwillTime.js";

const iso = (date: Date) => date.toISOString();

describe("shopgoodwillTimeToDate", () => {
  it("reads the digits as Pacific time (item 283669554, in winter)", () => {
    // Captured from the live API: endTime 18:07 Pacific, 2026-11-20
    assert.equal(iso(shopgoodwillTimeToDate("2026-11-20T18:07:00")), "2026-11-21T02:07:00.000Z");
  });

  it("agrees with the real UTC time of the API's own serverTime", () => {
    // serverTime "2026-11-11T23:10:57.627" was returned at 2026-11-12T07:11:02Z
    const server = shopgoodwillTimeToDate("2026-11-11T23:10:57.627").getTime();
    const observed = Date.parse("2026-11-12T07:11:02.360Z");
    assert.ok(Math.abs(observed - server) < 10_000);
  });

  it("keeps fractional seconds", () => {
    assert.equal(iso(shopgoodwillTimeToDate("2026-11-11T23:10:57.627")), "2026-11-12T07:10:57.627Z");
  });

  it("uses daylight time in summer", () => {
    assert.equal(iso(shopgoodwillTimeToDate("2026-07-15T18:00:00")), "2026-07-16T01:00:00.000Z");
  });

  it("does not depend on the server's own timezone", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/New_York", "Asia/Tokyo"]) {
        process.env.TZ = tz;
        assert.equal(iso(shopgoodwillTimeToDate("2026-11-20T18:07:00")), "2026-11-21T02:07:00.000Z");
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("takes a value that already has an offset at its word", () => {
    assert.equal(iso(shopgoodwillTimeToDate("2026-11-20T18:07:00Z")), "2026-11-20T18:07:00.000Z");
    assert.equal(iso(shopgoodwillTimeToDate("2026-11-20T18:07:00-05:00")), "2026-11-20T23:07:00.000Z");
  });

  it("returns a Date unchanged and an invalid date for garbage", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    assert.equal(shopgoodwillTimeToDate(date), date);
    assert.ok(Number.isNaN(shopgoodwillTimeToDate("not a date").getTime()));
    assert.ok(Number.isNaN(shopgoodwillTimeToDate(null as never).getTime()));
  });
});

describe("wallClockToDate", () => {
  const pacific = (month: number, day: number, hour: number, minute = 0) =>
    iso(wallClockToDate({ year: 2026, month, day, hour, minute, second: 0 }, "America/Los_Angeles"));

  it("handles midnight as hour 0 of the day", () => {
    assert.equal(pacific(11, 13, 0), "2026-11-13T08:00:00.000Z");
    assert.equal(pacific(7, 13, 0), "2026-07-13T07:00:00.000Z");
    assert.equal(pacific(11, 13, 23, 59), "2026-11-14T07:59:00.000Z");
  });

  it("follows the March change (clocks forward on 8 March 2026)", () => {
    assert.equal(pacific(3, 8, 1, 30), "2026-03-08T09:30:00.000Z"); // PST
    assert.equal(pacific(3, 8, 12), "2026-03-08T19:00:00.000Z"); // PDT
    assert.equal(pacific(3, 8, 2, 30), "2026-03-08T09:30:00.000Z"); // does not exist: an hour earlier
  });

  it("follows the November change (clocks back on 1 November 2026)", () => {
    assert.equal(pacific(11, 1, 0, 30), "2026-11-01T07:30:00.000Z"); // PDT
    assert.equal(pacific(11, 1, 1, 30), "2026-11-01T08:30:00.000Z"); // happens twice: the first
    assert.equal(pacific(11, 1, 12), "2026-11-01T20:00:00.000Z"); // PST
  });
});
