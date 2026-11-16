# ShopGoodwill Typescript API

A small TypeScript client for the Shopgoodwill buyer API. Requires Node 22 or newer and has no runtime dependencies.

```ts
import Shopgoodwill from "shopgoodwill-ts-api";

const api = new Shopgoodwill({
  // Either the values your browser sends when you sign in...
  encryptedUsername: process.env.SHOPGOODWILL_USERNAME,
  encryptedPassword: process.env.SHOPGOODWILL_PASSWORD,
  // ...or your plain userName and password, which are encoded the same way.
});

await api.authenticate();
const favorites = await api.get_favorites("open");
```

Call `authenticate()` before each batch of requests: it reuses the access token while it is still valid, swaps the refresh token for a new one once it has expired, and logs in again only when neither works.

The "encrypted" username and password use a fixed key that is public in Shopgoodwill's own site, so treat them exactly like the password itself.

Requests go only to `buyerapi.shopgoodwill.com` and give up after `REQUEST_TIMEOUT_MS` (30 seconds by default).

## Saving a session

A login gives an access token and a refresh token. Measured in November 2026, both last 30 days; a refresh gives a new 30-day access token but hands back the same refresh token with its first expiry. So a saved session lasts about 60 days from the login without the password, after which it has to log in again. Save the session and pass it back later, and the password is only needed for that:

```ts
import { readFile, writeFile } from "node:fs/promises";
import Shopgoodwill, { type ShopgoodwillSession } from "shopgoodwill-ts-api";

const saved = JSON.parse(await readFile("session.json", "utf8")) as ShopgoodwillSession;

const api = new Shopgoodwill(
  { session: saved },
  {
    // Called after every login and refresh: a refresh can replace the
    // refresh token, so keep the saved copy up to date
    onSessionChange: (session) =>
      writeFile("session.json", JSON.stringify(session), { mode: 0o600 }),
  }
);

await api.authenticate();
```

- `getSession()` returns the same object at any time (or `null` before there is one). It is plain JSON with ISO times: `accessToken`, `accessTokenExpiresAt` (from the token itself), `refreshToken`, `refreshTokenExpiresAt` and `refreshTokenIp` (the address Shopgoodwill recorded, sent back when refreshing, as the site does).
- A session is as good as the password while the refresh token lasts: keep it private.
- `onSessionChange` is awaited, and an error it throws comes out of `authenticate()`.
- A still-valid access token is refreshed once less than `REFRESH_BEFORE_MS` (7 days) is left, and once more when the refresh token itself has less than that left, which gives the longest-lived access token there can be. If an early refresh fails, the current token is kept.
- With a session and no credentials, `authenticate()` throws `ShopgoodwillAuthError` once both tokens are refused or expired: ask the user to sign in again. A refused refresh token is forgotten. An outage (`ShopgoodwillUnavailableError`) keeps it for the next try.
- `refresh()` does the swap on demand. `remember: true` in the constructor sends the site's "Remember me" with the login (default `false`).
- `jwtExpiry(token)` is exported too.

## Times

Shopgoodwill sends Pacific wall-clock times with no offset. `get_favorites` converts `startTime` and `endTime` to real `Date`s. If a time cannot be read it is left as an Invalid Date rather than failing the whole list, and `toISOString()` throws on one (`JSON.stringify` writes `null`), so check first:

```ts
for (const item of await api.get_favorites("open")) {
  if (Number.isNaN(item.endTime.getTime())) continue;
  console.log(item.title, item.endTime.toISOString());
}
```

## Errors

Failures about Shopgoodwill itself are `ShopgoodwillError`s (with `status` when there was a response); messages never contain response bodies, tokens or credentials.

- `ShopgoodwillAuthError`: the login was refused (HTTP 400/401/403, or no token came back) or the session was (HTTP 401/403). Check the credentials, or, if it came from a request after a successful login, the token has expired: call `authenticate()` again (it refreshes or logs in again when the token is no longer valid). It is also what any method throws if used before `authenticate()`, and what `authenticate()` throws when a saved session has run out and there are no credentials.
- `ShopgoodwillUnavailableError`: the network failed, the request timed out, or Shopgoodwill answered 5xx or 429. Says nothing about the credentials, so retry later. The underlying error is in `cause`.

Any other unsuccessful answer (a 404, a body that is not JSON) is a plain `ShopgoodwillError`. An abort you request with your own `signal` is rethrown unchanged.

The types (`ShopgoodwillFavorite`, ...) and `shopgoodwillTimeToDate` are exported from the package root.

## Releasing

Every merge to `main` is released by [semantic-release](https://semantic-release.gitbook.io) once CI has passed. It reads the commit messages since the last release and picks the version: `fix:` is a patch, `feat:` a minor, and `feat!:` or a `BREAKING CHANGE:` footer a major. `docs:`, `chore:` and `ci:` release nothing. It then publishes to npm (with provenance, through npm trusted publishing, so there is no npm token) and creates the GitHub release.

Pull requests are squash-merged, so the PR title becomes the commit message and must be a conventional commit; a check enforces it.
