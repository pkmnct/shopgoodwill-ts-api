import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  Shopgoodwill,
  ShopgoodwillAuthError,
  ShopgoodwillError,
  ShopgoodwillUnavailableError,
} from "./Shopgoodwill.js";

// A local fake of the parts of the buyer API the client uses. Nothing here is
// a real credential: "good" and "stale" are made-up tokens.

interface Seen {
  path: string;
  authorization?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let root: string;
let seen: Seen[];
let hang: boolean;
let loginStatus: number;
let noToken: boolean;
let favorites: unknown[];
let favoritesHtml: boolean;
/** Merged into a successful login response. */
let loginExtra: Record<string, unknown>;
/** Tokens GetSaveSearches accepts. */
let validTokens: Set<string>;
let refreshStatus: number;
/** The body of a 200 refresh response. */
let refreshBody: Record<string, unknown>;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const path = req.url ?? "";
      seen.push({ path, authorization: req.headers.authorization, headers: req.headers, body });
      if (hang) return; // never answers
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (path.startsWith("/api/SignIn/Login")) {
        return loginStatus === 200
          ? json(200, noToken ? {} : { accessToken: "good", ...loginExtra })
          : json(loginStatus, {});
      }
      if (path.startsWith("/api/SignIn/RefreshToken")) {
        return json(refreshStatus, refreshStatus === 200 ? refreshBody : {});
      }
      if (path.startsWith("/api/SaveSearches/GetSaveSearches")) {
        const token = req.headers.authorization?.replace(/^Bearer /, "");
        if (token && validTokens.has(token)) return json(200, { data: [] });
        return json(req.headers.authorization === "Bearer forbidden" ? 403 : 401, {});
      }
      if (path.startsWith("/api/Favorite/GetAllFavoriteItemsByType")) {
        if (favoritesHtml) {
          res.writeHead(200, { "Content-Type": "text/html" });
          return res.end("<html>Down for maintenance</html>");
        }
        return json(200, { data: favorites });
      }
      json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  seen = [];
  hang = false;
  loginStatus = 200;
  noToken = false;
  favorites = [];
  favoritesHtml = false;
  loginExtra = {};
  validTokens = new Set(["good"]);
  refreshStatus = 200;
  // What Shopgoodwill answers for a refresh token it does not accept
  refreshBody = { status: false, message: "Invalid Refresh Token.", accessToken: null, refreshToken: null };
});

const client = (auth: ConstructorParameters<typeof Shopgoodwill>[0]) => {
  const api = new Shopgoodwill(auth);
  api.API_ROOT = root;
  return api;
};
const logins = () => seen.filter((s) => s.path.startsWith("/api/SignIn/Login"));

describe("login values", () => {
  // Known answers from `openssl enc -aes-256-cbc -K <key> -iv <iv> -base64`,
  // escaped with Python's urllib.parse.quote. They pin the cipher, not a
  // round trip through this code.
  const vectors: [string, string][] = [
    ["jane", "9GXUuXB6pTxvyGg11x4HrA%3D%3D"],
    ["jane.doe@example.com", "9tONymMdmBFbZfSqrzdKzDi1YOuEePU7pf/WVt7t29c%3D"],
    ["p@ss/wörd 1!+long-password-123", "0bmmUx5bWX3M3QMjp2ODuZ4XYwnJjbocJeS83w8c0Ik%3D"],
  ];

  it("encodes a plain userName and password like the site does", async () => {
    for (const [plain, encoded] of vectors) {
      seen = [];
      const api = client({ userName: plain, password: vectors[0]![0] });
      await api.authenticate();
      const sent = JSON.parse(logins()[0]!.body) as { username: string; password: string };
      assert.equal(sent.username, encoded, plain);
      assert.equal(sent.password, vectors[0]![1]);
    }
  });

  it("sends pre-encrypted values untouched", async () => {
    await client({ encryptedUsername: "AAA%3D", encryptedPassword: "BBB%3D" }).authenticate();
    const sent = JSON.parse(logins()[0]!.body) as { username: string; password: string };
    assert.deepEqual([sent.username, sent.password], ["AAA%3D", "BBB%3D"]);
  });
});

describe("authenticate", () => {
  it("logs in and sends the token on later requests", async () => {
    const api = client({ encryptedUsername: "u", encryptedPassword: "p" });
    await api.authenticate();
    await api.get_favorites("all");
    assert.equal(seen.at(-1)!.authorization, "Bearer good");
  });

  it("reuses a token that is still valid without logging in", async () => {
    await client({ accessToken: "good", encryptedUsername: "u", encryptedPassword: "p" }).authenticate();
    assert.equal(logins().length, 0);
  });

  it("logs in again when the token has expired (401)", async () => {
    const api = client({ accessToken: "stale", encryptedUsername: "u", encryptedPassword: "p" });
    await api.authenticate();
    assert.equal(logins().length, 1);
    await api.get_favorites("all");
    assert.equal(seen.at(-1)!.authorization, "Bearer good");
  });

  it("also treats a 403 on the token check as expired and logs in again", async () => {
    const api = client({ accessToken: "forbidden", encryptedUsername: "u", encryptedPassword: "p" });
    await api.authenticate();
    assert.equal(logins().length, 1);
  });

  it("raises an auth error when used before authenticate()", async () => {
    await assert.rejects(
      client({ encryptedUsername: "u", encryptedPassword: "p" }).get_favorites("all"),
      ShopgoodwillAuthError
    );
  });

  it("raises a clear error for rejected credentials", async () => {
    loginStatus = 401;
    await assert.rejects(
      client({ encryptedUsername: "u", encryptedPassword: "p" }).authenticate(),
      (error: unknown) =>
        error instanceof ShopgoodwillAuthError &&
        error.status === 401 &&
        /Login failed: Shopgoodwill returned HTTP 401/.test(error.message)
    );
  });

  it("calls an outage an outage, not a rejected login", async () => {
    for (const status of [500, 503, 429]) {
      loginStatus = status;
      await assert.rejects(
        client({ encryptedUsername: "u", encryptedPassword: "p" }).authenticate(),
        (error: unknown) =>
          error instanceof ShopgoodwillUnavailableError && error.status === status
      );
    }
  });

  it("tells a missing token from an outage", async () => {
    loginStatus = 200;
    noToken = true;
    await assert.rejects(
      client({ encryptedUsername: "u", encryptedPassword: "p" }).authenticate(),
      ShopgoodwillAuthError
    );
  });

  it("is still a ShopgoodwillError with the class name for any of them", async () => {
    loginStatus = 401;
    await assert.rejects(
      client({ encryptedUsername: "u", encryptedPassword: "p" }).authenticate(),
      (error: unknown) =>
        error instanceof ShopgoodwillError &&
        error instanceof Error &&
        error.name === "ShopgoodwillAuthError"
    );
  });

  it("shares one login between parallel calls", async () => {
    const api = client({ encryptedUsername: "u", encryptedPassword: "p" });
    await Promise.all([api.authenticate(), api.authenticate(), api.authenticate()]);
    assert.equal(logins().length, 1);
  });

  it("does not keep a failed login for the next call", async () => {
    const api = client({ encryptedUsername: "u", encryptedPassword: "p" });
    loginStatus = 503;
    await assert.rejects(api.authenticate(), ShopgoodwillUnavailableError);
    loginStatus = 200;
    await api.authenticate();
    assert.equal(logins().length, 2);
  });

  it("treats a 400 as refused credentials on login only", async () => {
    loginStatus = 400;
    await assert.rejects(
      client({ encryptedUsername: "u", encryptedPassword: "p" }).authenticate(),
      ShopgoodwillAuthError
    );
  });

  it("does not log in from the constructor", () => {
    client({ encryptedUsername: "u", encryptedPassword: "p" });
    assert.equal(seen.length, 0);
  });
});

describe("sessions and refresh", () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** A made-up JWT (unsigned) that expires `ms` from now. */
  const jwt = (ms: number, name = "jwt") =>
    `x.${Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + ms) / 1000), name })).toString("base64url")}.sig`;
  const refreshes = () => seen.filter((s) => s.path.startsWith("/api/SignIn/RefreshToken"));
  const checks = () => seen.filter((s) => s.path.startsWith("/api/SaveSearches/GetSaveSearches"));
  // The shape the site sends, with Pacific wall-clock times
  const refreshObject = (token: string) => ({
    token,
    expires: "2026-12-14T21:08:51",
    created: "2026-11-14T21:08:51",
    createdByIp: "203.0.113.7",
  });

  it("keeps the refresh token from the login and reports the session", async () => {
    const access = jwt(30 * DAY);
    validTokens.add(access);
    loginExtra = { accessToken: access, refreshToken: refreshObject("r1") };
    const reported: unknown[] = [];
    const api = new Shopgoodwill(
      { encryptedUsername: "u", encryptedPassword: "p" },
      { onSessionChange: (session) => void reported.push(session) }
    );
    api.API_ROOT = root;
    await api.authenticate();

    const session = api.getSession()!;
    assert.equal(session.accessToken, access);
    assert.equal(new Date(session.accessTokenExpiresAt!).getTime(), Math.floor((Date.now() + 30 * DAY) / 1000) * 1000);
    assert.equal(session.refreshToken, "r1");
    // 21:08:51 Pacific (PST) is 05:08:51 UTC the next day
    assert.equal(session.refreshTokenExpiresAt, "2026-12-15T05:08:51.000Z");
    assert.equal(session.refreshTokenIp, "203.0.113.7");
    assert.deepEqual(reported, [session]);
  });

  it("is null before anything is known, and survives a JSON round trip", async () => {
    assert.equal(client({ encryptedUsername: "u", encryptedPassword: "p" }).getSession(), null);
    loginExtra = { refreshToken: refreshObject("r1") };
    const first = client({ encryptedUsername: "u", encryptedPassword: "p" });
    await first.authenticate();
    const saved = JSON.parse(JSON.stringify(first.getSession()));
    assert.deepEqual(client({ session: saved }).getSession(), first.getSession());
  });

  it("uses a saved session without the password", async () => {
    await client({ session: { accessToken: "good" } }).authenticate();
    assert.equal(logins().length, 0);
    assert.equal(refreshes().length, 0);
  });

  it("refreshes an expired access token, sending back the recorded address and no bearer", async () => {
    refreshBody = { accessToken: "good", refreshToken: refreshObject("r2") };
    const reported: string[] = [];
    const api = new Shopgoodwill(
      {
        session: {
          accessToken: jwt(-DAY),
          refreshToken: "r1",
          refreshTokenExpiresAt: new Date(Date.now() + DAY).toISOString(),
          refreshTokenIp: "203.0.113.7",
        },
      },
      { onSessionChange: (session) => void reported.push(session.refreshToken!) }
    );
    api.API_ROOT = root;
    await api.authenticate();

    // Its own expiry has passed, so it is not checked first
    assert.equal(checks().length, 0);
    const [sent] = refreshes();
    assert.deepEqual(JSON.parse(sent!.body), { refreshToken: "r1", clientIpAddress: "203.0.113.7" });
    assert.equal(sent!.authorization, undefined);
    assert.deepEqual(reported, ["r2"]);
    await api.get_favorites("all");
    assert.equal(seen.at(-1)!.authorization, "Bearer good");
  });

  it("refreshes when Shopgoodwill rejects the access token (401)", async () => {
    refreshBody = { accessToken: "good" };
    const api = client({ session: { accessToken: "stale", refreshToken: "r1" } });
    await api.authenticate();
    assert.equal(refreshes().length, 1);
    assert.equal(logins().length, 0);
    // No refresh token came back: the old one is not kept
    assert.equal(api.getSession()!.refreshToken, undefined);
  });

  it("accepts a refresh token sent as a plain string", async () => {
    refreshBody = { accessToken: "good", refreshToken: "r2" };
    const api = client({ session: { accessToken: "stale", refreshToken: "r1" } });
    await api.authenticate();
    assert.equal(api.getSession()!.refreshToken, "r2");
  });

  it("logs in with the credentials when the refresh token is refused", async () => {
    const api = client({
      session: { accessToken: "stale", refreshToken: "r1" },
      encryptedUsername: "u",
      encryptedPassword: "p",
    });
    await api.authenticate();
    assert.equal(refreshes().length, 1);
    assert.equal(logins().length, 1);
  });

  it("asks for a new sign-in when the session has run out and there are no credentials", async () => {
    const api = client({ session: { accessToken: "stale", refreshToken: "r1" } });
    await assert.rejects(
      api.authenticate(),
      (error: unknown) => error instanceof ShopgoodwillAuthError && /sign in again/.test(error.message)
    );
    // The refused refresh token is forgotten, so it is not tried again
    assert.equal(api.getSession()!.refreshToken, undefined);
    seen = [];
    await assert.rejects(api.authenticate(), ShopgoodwillAuthError);
    assert.equal(refreshes().length, 0);
  });

  it("also treats an HTTP 401 from the refresh as refused", async () => {
    refreshStatus = 401;
    await assert.rejects(
      client({ session: { accessToken: "stale", refreshToken: "r1" } }).authenticate(),
      ShopgoodwillAuthError
    );
  });

  it("keeps the refresh token through an outage and does not try the password", async () => {
    refreshStatus = 503;
    const api = client({
      session: { accessToken: "stale", refreshToken: "r1" },
      encryptedUsername: "u",
      encryptedPassword: "p",
    });
    await assert.rejects(api.authenticate(), ShopgoodwillUnavailableError);
    assert.equal(logins().length, 0);
    assert.equal(api.getSession()!.refreshToken, "r1");
  });

  it("skips a refresh token that has expired", async () => {
    const api = client({
      session: {
        accessToken: "stale",
        refreshToken: "r1",
        refreshTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      },
      encryptedUsername: "u",
      encryptedPassword: "p",
    });
    await api.authenticate();
    assert.equal(refreshes().length, 0);
    assert.equal(logins().length, 1);
  });

  it("refreshes early once the access token is close to expiring", async () => {
    const soon = jwt(2 * DAY);
    validTokens.add(soon);
    refreshBody = { accessToken: "good", refreshToken: refreshObject("r2") };
    const api = client({ session: { accessToken: soon, refreshToken: "r1" } });
    await api.authenticate();
    assert.equal(refreshes().length, 1);
    assert.equal(api.getSession()!.accessToken, "good");

    seen = [];
    const later = jwt(20 * DAY);
    validTokens.add(later);
    await client({ session: { accessToken: later, refreshToken: "r1" } }).authenticate();
    assert.equal(refreshes().length, 0);
  });

  it("refreshes once more just before the refresh token runs out, then stops", async () => {
    // As measured: the refresh token keeps its first expiry, and a refresh
    // gives a new 30-day access token with the same refresh token back
    const refreshExpires = new Date(Date.now() + 3 * DAY).toISOString();
    const loginAccess = jwt(5 * DAY, "login");
    const refreshed = jwt(30 * DAY, "refreshed");
    validTokens.add(loginAccess).add(refreshed);
    refreshBody = { accessToken: refreshed, refreshToken: { token: "r1", expires: refreshExpires } };
    const api = client({
      session: { accessToken: loginAccess, refreshToken: "r1", refreshTokenExpiresAt: refreshExpires },
    });
    // 5 days left on the access token would not trigger it on its own
    api.REFRESH_BEFORE_MS = 4 * DAY;
    await api.authenticate();
    assert.equal(refreshes().length, 1);
    assert.equal(api.getSession()!.accessToken, refreshed);

    await api.authenticate();
    await api.authenticate();
    assert.equal(refreshes().length, 1);
  });

  it("does not try a refresh token whose own expiry has passed", async () => {
    const soon = jwt(2 * DAY);
    validTokens.add(soon);
    const api = client({
      session: {
        accessToken: soon,
        refreshToken: "r1",
        refreshTokenExpiresAt: new Date(Date.now() - DAY).toISOString(),
      },
    });
    await api.authenticate();
    assert.equal(refreshes().length, 0);
  });

  it("keeps a still-valid token when the early refresh fails", async () => {
    const soon = jwt(2 * DAY);
    validTokens.add(soon);
    for (const status of [200, 503]) {
      seen = [];
      refreshStatus = status; // 200 here is the "Invalid Refresh Token." answer
      const api = client({ session: { accessToken: soon, refreshToken: "r1" } });
      await api.authenticate();
      await api.get_favorites("all");
      assert.equal(seen.at(-1)!.authorization, `Bearer ${soon}`, String(status));
    }
  });

  it("sends Remember me only when asked", async () => {
    await client({ encryptedUsername: "u", encryptedPassword: "p" }).authenticate();
    await client({ encryptedUsername: "u", encryptedPassword: "p", remember: true }).authenticate();
    assert.deepEqual(
      logins().map((login) => (JSON.parse(login.body) as { remember: boolean }).remember),
      [false, true]
    );
  });

  it("does not write tokens into the caller's object", async () => {
    const auth = { encryptedUsername: "u", encryptedPassword: "p" };
    await client(auth).authenticate();
    assert.deepEqual(auth, { encryptedUsername: "u", encryptedPassword: "p" });
  });

  it("reads a JWT's expiry, and nothing from a token that is not one", async () => {
    const { jwtExpiry } = await import("./index.js");
    assert.equal(jwtExpiry("x.eyJleHAiOjE3MDAwMDAwMDB9.sig")?.toISOString(), "2023-11-14T22:13:20.000Z");
    assert.equal(jwtExpiry("opaque"), undefined);
    assert.equal(jwtExpiry("x.!!!.sig"), undefined);
    assert.equal(jwtExpiry("x.eyJleHAiOiJzb29uIn0.sig"), undefined);
  });
});

describe("requests", () => {
  it("gives up after REQUEST_TIMEOUT_MS", async () => {
    hang = true;
    const api = client({});
    api.REQUEST_TIMEOUT_MS = 50;
    await assert.rejects(
      api.get("/anything"),
      (error: unknown) =>
        error instanceof ShopgoodwillUnavailableError &&
        /did not answer within 50 ms/.test(error.message) &&
        (error.cause as Error).name === "TimeoutError"
    );
  });

  it("reports an unreachable server as unavailable, with the cause", async () => {
    const api = client({});
    api.API_ROOT = "http://127.0.0.1:1/api";
    await assert.rejects(
      api.get("/x"),
      (error: unknown) =>
        error instanceof ShopgoodwillUnavailableError &&
        error.cause instanceof Error &&
        error.message === "Could not reach Shopgoodwill"
    );
  });

  it("keeps the session headers when a caller adds its own", async () => {
    const api = client({ encryptedUsername: "u", encryptedPassword: "p" });
    await api.authenticate();
    await api.post("/SaveSearches/GetSaveSearches", { headers: { "X-Extra": "1" } });
    const last = seen.at(-1)!;
    assert.equal(last.authorization, "Bearer good");
    assert.equal(last.headers["x-extra"], "1");
    assert.equal(last.headers["origin"], "https://shopgoodwill.com");
  });

  it("keeps the timeout when a caller passes its own signal, and honours the caller's abort", async () => {
    hang = true;
    const api = client({});
    api.REQUEST_TIMEOUT_MS = 50;
    await assert.rejects(
      api.post("/x", { signal: new AbortController().signal }),
      (error: unknown) => error instanceof ShopgoodwillUnavailableError
    );
    const controller = new AbortController();
    const pending = api.post("/x", { signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await assert.rejects(pending, /caller gave up/);
  });
});

describe("get_favorites", () => {
  it("returns start and end times as real instants (Pacific wall clock)", async () => {
    favorites = [{ itemId: 1, title: "a", startTime: "2026-11-10T11:19:26", endTime: "2026-11-20T18:07:00" }];
    const api = client({ encryptedUsername: "u", encryptedPassword: "p" });
    await api.authenticate();
    const [item] = await api.get_favorites("all");
    assert.ok(item!.endTime instanceof Date);
    assert.equal(item!.endTime.toISOString(), "2026-11-21T02:07:00.000Z");
    assert.equal(item!.startTime.toISOString(), "2026-11-10T19:19:26.000Z");
  });

  it("leaves an unreadable time as an Invalid Date without failing the list", async () => {
    favorites = [
      { itemId: 1, title: "bad", startTime: null, endTime: "garbage" },
      { itemId: 2, title: "ok", startTime: "2026-11-10T11:19:26", endTime: "2026-11-20T18:07:00" },
    ];
    const api = client({ encryptedUsername: "u", encryptedPassword: "p" });
    await api.authenticate();
    const items = await api.get_favorites("all");
    assert.equal(items.length, 2);
    assert.ok(Number.isNaN(items[0]!.endTime.getTime()));
    assert.equal(items[1]!.endTime.toISOString(), "2026-11-21T02:07:00.000Z");
  });
});

describe("other endpoints", () => {
  const signedIn = async () => {
    const api = client({ encryptedUsername: "u", encryptedPassword: "p" });
    await api.authenticate();
    return api;
  };

  it("raises when adding a favorite is refused, instead of doing nothing", async () => {
    const api = await signedIn();
    await assert.rejects(
      api.add_favorite(42),
      (error: unknown) =>
        error instanceof ShopgoodwillError &&
        !(error instanceof ShopgoodwillAuthError) &&
        error.status === 404
    );
  });

  it("reports an HTML body as a ShopgoodwillError with the status, not a SyntaxError", async () => {
    const api = await signedIn();
    favoritesHtml = true;
    await assert.rejects(
      api.get_favorites("all"),
      (error: unknown) =>
        error instanceof ShopgoodwillError &&
        error.status === 200 &&
        /did not answer with JSON/.test(error.message) &&
        !/maintenance/.test(error.message)
    );
  });

  it("exports the favorites types' enum and the time helper from the package root", async () => {
    const root = await import("./index.js");
    assert.equal(typeof root.shopgoodwillTimeToDate, "function");
    assert.equal(typeof root.ShopgoodwillFavoriteType, "object");
    assert.equal(root.default, Shopgoodwill);
  });
});
