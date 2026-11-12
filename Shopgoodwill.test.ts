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
        return loginStatus === 200 ? json(200, noToken ? {} : { accessToken: "good" }) : json(loginStatus, {});
      }
      if (path.startsWith("/api/SaveSearches/GetSaveSearches")) {
        return req.headers.authorization === "Bearer good" ? json(200, { data: [] }) : json(401, {});
      }
      if (path.startsWith("/api/Favorite/GetAllFavoriteItemsByType")) {
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

  it("does not log in from the constructor", () => {
    client({ encryptedUsername: "u", encryptedPassword: "p" });
    assert.equal(seen.length, 0);
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
