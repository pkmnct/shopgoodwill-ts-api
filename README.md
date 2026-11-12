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

## Releasing

Every merge to `main` is released by [semantic-release](https://semantic-release.gitbook.io) once CI has passed. It reads the commit messages since the last release and picks the version: `fix:` is a patch, `feat:` a minor, and `feat!:` or a `BREAKING CHANGE:` footer a major. `docs:`, `chore:` and `ci:` release nothing. It then publishes to npm (with provenance, through npm trusted publishing, so there is no npm token) and creates the GitHub release.

Pull requests are squash-merged, so the PR title becomes the commit message and must be a conventional commit; a check enforces it.
