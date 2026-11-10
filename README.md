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
