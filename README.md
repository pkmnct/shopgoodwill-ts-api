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

Call `authenticate()` before each batch of requests: it reuses the access token while it is still valid and logs in again once it has expired.

The "encrypted" username and password use a fixed key that is public in Shopgoodwill's own site, so treat them exactly like the password itself.

Requests go only to `buyerapi.shopgoodwill.com` and give up after `REQUEST_TIMEOUT_MS` (30 seconds by default).

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

- `ShopgoodwillAuthError`: the login was refused (HTTP 400/401/403, or no token came back) or the session was (HTTP 401/403). Check the credentials, or, if it came from a request after a successful login, the token has expired: call `authenticate()` again (it logs in again when the token is no longer valid). It is also what any method throws if used before `authenticate()`.
- `ShopgoodwillUnavailableError`: the network failed, the request timed out, or Shopgoodwill answered 5xx or 429. Says nothing about the credentials, so retry later. The underlying error is in `cause`.

Any other unsuccessful answer (a 404, a body that is not JSON) is a plain `ShopgoodwillError`. An abort you request with your own `signal` is rethrown unchanged.

The types (`ShopgoodwillFavorite`, ...) and `shopgoodwillTimeToDate` are exported from the package root.

## Releasing

Every merge to `main` is released by [semantic-release](https://semantic-release.gitbook.io) once CI has passed. It reads the commit messages since the last release and picks the version: `fix:` is a patch, `feat:` a minor, and `feat!:` or a `BREAKING CHANGE:` footer a major. `docs:`, `chore:` and `ci:` release nothing. It then publishes to npm (with provenance, through npm trusted publishing, so there is no npm token) and creates the GitHub release.

Pull requests are squash-merged, so the PR title becomes the commit message and must be a conventional commit; a check enforces it.
