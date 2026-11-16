import { ShopgoodwillFavorite } from "./Favorite.js";
import { createCipheriv } from "node:crypto";
import { shopgoodwillTimeToDate } from "./ShopgoodwillTime.js";

/**
 * Everything this client throws on purpose about Shopgoodwill itself. Messages
 * never include response bodies, tokens or credentials.
 */
export class ShopgoodwillError extends Error {
  constructor(
    message: string,
    /** The HTTP status, when there was a response. */
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Shopgoodwill refused the login (HTTP 400/401/403, or no token) or the
 * session (HTTP 401/403). Call authenticate() again, then check the credentials.
 */
export class ShopgoodwillAuthError extends ShopgoodwillError {}

/**
 * Shopgoodwill could not be reached or is failing (network error, timeout,
 * HTTP 5xx or 429). Says nothing about the credentials: retry later.
 */
export class ShopgoodwillUnavailableError extends ShopgoodwillError {}

const isUnavailableStatus = (status: number) => status >= 500 || status === 429;

/**
 * The right error class for an unsuccessful response. A 400 means refused
 * credentials only on the login request; anywhere else it is a plain error.
 */
const httpError = (
  message: string,
  status: number,
  isLogin = false
): ShopgoodwillError => {
  const text = `${message}: Shopgoodwill returned HTTP ${status}`;
  if (status === 401 || status === 403 || (isLogin && status === 400)) {
    return new ShopgoodwillAuthError(text, status);
  }
  if (isUnavailableStatus(status)) {
    return new ShopgoodwillUnavailableError(text, status);
  }
  return new ShopgoodwillError(text, status);
};

export interface AuthInfo {
  userName?: string;
  password?: string;
  accessToken?: string;
  encryptedUsername?: string;
  encryptedPassword?: string;
  /**
   * A session saved from `getSession()` or `onSessionChange`. Its access
   * token is used while it is valid, then its refresh token, and the
   * credentials above (if any) only when both have run out.
   */
  session?: ShopgoodwillSession;
  /** Sent as the site's "Remember me" when logging in. Default false. */
  remember?: boolean;
}

/**
 * Everything needed to carry on without the password, as plain JSON (times
 * are ISO strings), so it can be written to a file as is. Treat it like a
 * password for as long as the refresh token lasts.
 */
export interface ShopgoodwillSession {
  accessToken: string;
  /** From the token's own expiry; absent if it does not carry one. */
  accessTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  /**
   * The address Shopgoodwill recorded for the refresh token. The site sends it
   * back when refreshing, so this client does too.
   */
  refreshTokenIp?: string;
}

export interface ShopgoodwillOptions {
  /**
   * Called with the new session after every login and refresh, and awaited:
   * save it here. A refresh may replace the refresh token, so a saved copy
   * that is not updated can stop working.
   */
  onSessionChange?: (session: ShopgoodwillSession) => void | Promise<void>;
}

/** The expiry in a JWT's payload, if the token is a JWT that has one. */
export const jwtExpiry = (token: string): Date | undefined => {
  const payload = token.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    }).exp;
    return typeof exp === "number" && Number.isFinite(exp)
      ? new Date(exp * 1000)
      : undefined;
  } catch {
    return undefined;
  }
};

const validDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string" && !(value instanceof Date)) {
    return undefined;
  }
  const date = shopgoodwillTimeToDate(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

export interface SavedSearch {
  todo?: undefined;
}

export interface ShopgoodwillApiResponse extends Response {
  json: () => Promise<{
    [key: string]: unknown;
  }>;
}

export class Shopgoodwill {
  public LOGIN_PAGE_URL = "https://shopgoodwill.com/signin";
  public API_ROOT = "https://buyerapi.shopgoodwill.com/api";
  public ENCRYPTION_INFO = {
    key: Buffer.from("6696D2E6F042FEC4D6E3F32AD541143B"),
    iv: Buffer.from("0000000000000000"),
    block_size: 16,
  };
  public FAVORITES_MAX_NOTE_LENGTH = 256;
  /** Give up on a request to Shopgoodwill after this many milliseconds. */
  public REQUEST_TIMEOUT_MS = 30_000;
  /**
   * `authenticate()` refreshes a still-valid access token once it has less
   * than this long left, so a session in regular use does not run out.
   */
  public REFRESH_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
  /** Sent as clientIpAddress, as the reference client does. */
  private CLIENT_IP_ADDRESS = "0.0.0.4";

  private shopgoodwill_session_headers: { [key: string]: string } = {
    "Content-Type": "application/json",
    Origin: "https://shopgoodwill.com",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 6.1; WOW64; rv:12.0) Gecko/20100101 Firefox/12.0",
  };
  private auth_info: AuthInfo;
  private options: ShopgoodwillOptions;
  private access_token_expires_at?: Date;
  private refresh_token?: string;
  private refresh_token_expires_at?: Date;
  private refresh_token_ip?: string;

  /**
   * Stores the credentials only. Call `authenticate()` and await it before
   * using endpoints that need a login.
   */
  constructor(auth_info: AuthInfo, options: ShopgoodwillOptions = {}) {
    // A copy: tokens are written to it, and must not leak into the caller's object
    this.auth_info = { ...auth_info };
    this.options = options;
    const session = auth_info.session;
    if (session) {
      this.auth_info.accessToken ??= session.accessToken;
      this.refresh_token = session.refreshToken;
      this.refresh_token_expires_at = validDate(session.refreshTokenExpiresAt);
      this.refresh_token_ip = session.refreshTokenIp;
    }
    if (this.auth_info.accessToken) {
      this.access_token_expires_at =
        (this.auth_info.accessToken === session?.accessToken
          ? validDate(session.accessTokenExpiresAt)
          : undefined) ?? jwtExpiry(this.auth_info.accessToken);
    }
  }

  /**
   * The current session, to save and pass back as `session` later, or null
   * before the first successful `authenticate()` (or `session` given).
   */
  public getSession = (): ShopgoodwillSession | null => {
    const accessToken = this.auth_info.accessToken;
    if (!accessToken) {
      return null;
    }
    const session: ShopgoodwillSession = { accessToken };
    if (this.access_token_expires_at) {
      session.accessTokenExpiresAt = this.access_token_expires_at.toISOString();
    }
    if (this.refresh_token) {
      session.refreshToken = this.refresh_token;
      if (this.refresh_token_expires_at) {
        session.refreshTokenExpiresAt = this.refresh_token_expires_at.toISOString();
      }
      if (this.refresh_token_ip) {
        session.refreshTokenIp = this.refresh_token_ip;
      }
    }
    return session;
  };

  private pending_authenticate?: Promise<void>;

  /**
   * Reuses the access token while it is valid (refreshing it when it is close
   * to expiring), then tries the refresh token, and logs in with the
   * credentials only when neither works. Calls made while one is already
   * running share it, so parallel callers cause one login, not several.
   *
   * Throws ShopgoodwillAuthError when Shopgoodwill refuses the credentials,
   * or when the session has run out and there are no credentials to log in
   * with (the caller should ask the user to sign in again).
   */
  public authenticate = (): Promise<void> => {
    this.pending_authenticate ??= this.run_authenticate().finally(() => {
      this.pending_authenticate = undefined;
    });
    return this.pending_authenticate;
  };

  private expired = (at: Date | undefined, marginMs = 0): boolean =>
    at !== undefined && Date.now() + marginMs >= at.getTime();

  /**
   * Whether to refresh an access token that still works. Measured in November
   * 2026: a refresh gives a new 30-day access token but keeps the same
   * refresh token, which still expires 30 days after the login. So refresh
   * once the access token is close to expiring, and also once more just
   * before the refresh token runs out, which gives the longest-lived access
   * token there can be (about 60 days from the login in all).
   */
  private should_refresh_early = (): boolean => {
    if (!this.refresh_token || this.expired(this.refresh_token_expires_at)) {
      return false;
    }
    const margin = this.REFRESH_BEFORE_MS;
    if (this.expired(this.access_token_expires_at, margin)) {
      return true;
    }
    const access = this.access_token_expires_at;
    const refresh = this.refresh_token_expires_at;
    // After that last refresh the access token outlasts the refresh token by
    // more than the margin, so this does not repeat on every call
    return (
      access !== undefined &&
      refresh !== undefined &&
      this.expired(refresh, margin) &&
      access.getTime() <= refresh.getTime() + margin
    );
  };

  private run_authenticate = async (): Promise<void> => {
    const accessToken = this.auth_info.accessToken;
    // A token whose own expiry has passed is not worth asking about
    if (
      accessToken &&
      !this.expired(this.access_token_expires_at) &&
      (await this.access_token_is_valid(accessToken))
    ) {
      if (this.should_refresh_early()) {
        // Still valid, so a failed early refresh is not worth failing over
        await this.refresh().catch((error: unknown) => {
          if (!(error instanceof ShopgoodwillError)) {
            throw error;
          }
          // The token checked out a moment ago: keep using it
          this.shopgoodwill_session_headers["Authorization"] = `Bearer ${accessToken}`;
        });
      }
      return;
    }

    if (this.refresh_token && !this.expired(this.refresh_token_expires_at)) {
      try {
        await this.refresh();
        return;
      } catch (error) {
        // An outage says nothing about the refresh token: keep it for next time
        if (!(error instanceof ShopgoodwillAuthError)) {
          throw error;
        }
      }
    }

    if (this.auth_info.encryptedUsername && this.auth_info.encryptedPassword) {
      await this.login(this.auth_info.encryptedUsername, this.auth_info.encryptedPassword);
    } else if (this.auth_info.userName && this.auth_info.password) {
      await this.login(
        this.encrypt_login_value(this.auth_info.userName),
        this.encrypt_login_value(this.auth_info.password)
      );
    } else if (accessToken || this.refresh_token) {
      throw new ShopgoodwillAuthError(
        "The saved session has expired and there are no credentials to log in with: sign in again"
      );
    } else {
      throw new Error("Invalid auth_info");
    }
  };

  /**
   * Stores the tokens from a login or refresh response, sends the access
   * token from now on, and reports the new session.
   */
  private take_tokens = async (
    body: { [key: string]: unknown },
    message: string
  ): Promise<void> => {
    const token = body["accessToken"];
    if (typeof token !== "string" || !token) {
      throw new ShopgoodwillAuthError(`${message}: no access token in the response`);
    }
    this.auth_info.accessToken = token;
    this.access_token_expires_at = jwtExpiry(token);
    this.shopgoodwill_session_headers["Authorization"] = `Bearer ${token}`;

    // An object ({ token, expires, createdByIp, ... }) as of 2026; a plain
    // string is accepted too. Without one, the old refresh token is dropped:
    // it is not known to be still good.
    const refresh = body["refreshToken"];
    const details =
      typeof refresh === "object" && refresh !== null
        ? (refresh as { [key: string]: unknown })
        : undefined;
    const refreshToken = typeof refresh === "string" ? refresh : details?.["token"];
    if (typeof refreshToken === "string" && refreshToken) {
      this.refresh_token = refreshToken;
      // Pacific wall clock with no offset, like every other Shopgoodwill time
      this.refresh_token_expires_at = validDate(details?.["expires"]);
      const ip = details?.["createdByIp"];
      this.refresh_token_ip = typeof ip === "string" && ip ? ip : undefined;
    } else {
      this.refresh_token = undefined;
      this.refresh_token_expires_at = undefined;
      this.refresh_token_ip = undefined;
    }

    const session = this.getSession();
    if (session && this.options.onSessionChange) {
      await this.options.onSessionChange(session);
    }
  };

  /**
   * Swaps the refresh token for a new access token (and, if Shopgoodwill
   * sends one, a new refresh token). Throws ShopgoodwillAuthError when the
   * refresh token is refused; it is then forgotten.
   */
  public refresh = async (): Promise<void> => {
    const refreshToken = this.refresh_token;
    if (!refreshToken) {
      throw new ShopgoodwillAuthError("No refresh token to refresh with");
    }
    // The endpoint takes no bearer token, and the old one may have expired
    delete this.shopgoodwill_session_headers["Authorization"];
    const res = await this.post("/SignIn/RefreshToken", {
      body: JSON.stringify({
        refreshToken,
        clientIpAddress: this.refresh_token_ip ?? this.CLIENT_IP_ADDRESS,
      }),
    });
    if (!res.ok) {
      const error = httpError("Refresh failed", res.status, true);
      if (error instanceof ShopgoodwillAuthError) {
        this.forget_refresh_token(refreshToken);
      }
      throw error;
    }
    const body = await this.read_json(res, "Refresh failed");
    // A refused refresh token is a 200 with accessToken: null
    if (typeof body["accessToken"] !== "string" || !body["accessToken"]) {
      this.forget_refresh_token(refreshToken);
      throw new ShopgoodwillAuthError("Refresh failed: Shopgoodwill refused the refresh token");
    }
    await this.take_tokens(body, "Refresh failed");
  };

  private forget_refresh_token = (refreshToken: string): void => {
    // Only if a login has not replaced it meanwhile
    if (this.refresh_token === refreshToken) {
      this.refresh_token = undefined;
      this.refresh_token_expires_at = undefined;
      this.refresh_token_ip = undefined;
    }
  };

  /**
   * Replicates SGW's "encryption" on username/password fields.
   *
   * It really isn't necessary since you can rip the encrypted values from your browser, but it'll make initial config just a tad easier
   */
  private encrypt_login_value = (value: string): string => {
    const cipher = createCipheriv(
      "aes-256-cbc",
      this.ENCRYPTION_INFO.key,
      this.ENCRYPTION_INFO.iv
    );
    const ciphertext =
      cipher.update(value, "utf8", "base64") + cipher.final("base64");

    // Same escaping as Python's urllib.parse.quote, which leaves "/" alone
    return encodeURIComponent(ciphertext).replaceAll("%2F", "/");
  };

  private request = async (
    path: string,
    options: RequestInit = {}
  ): Promise<ShopgoodwillApiResponse> => {
    // Caller headers are added to the session headers (so Authorization is
    // kept unless the caller deliberately sets it), and a caller's signal is
    // combined with the timeout instead of replacing it
    const headers = new Headers(this.shopgoodwill_session_headers);
    new Headers(options.headers).forEach((value, name) =>
      headers.set(name, value)
    );
    const timeout = AbortSignal.timeout(this.REQUEST_TIMEOUT_MS);
    try {
      return (await fetch(this.API_ROOT + path, {
        ...options,
        headers,
        signal: options.signal
          ? AbortSignal.any([timeout, options.signal])
          : timeout,
      })) as ShopgoodwillApiResponse;
    } catch (error) {
      // The caller's own abort is theirs: rethrow it unchanged
      if (options.signal?.aborted) {
        throw error;
      }
      throw new ShopgoodwillUnavailableError(
        timeout.aborted
          ? `Shopgoodwill did not answer within ${this.REQUEST_TIMEOUT_MS} ms`
          : "Could not reach Shopgoodwill",
        undefined,
        { cause: error }
      );
    }
  };

  /**
   * Reads a JSON body. An empty or HTML body (a maintenance or challenge
   * page) becomes a ShopgoodwillError that keeps the HTTP status, and a
   * timeout or dropped connection while reading becomes an unavailable error,
   * instead of a bare SyntaxError or TimeoutError.
   */
  private read_json = async (
    res: ShopgoodwillApiResponse,
    message: string
  ): Promise<{ [key: string]: unknown }> => {
    let body: unknown;
    try {
      body = await res.json();
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "AbortError") {
        throw error; // the caller's own abort
      }
      if (name === "SyntaxError") {
        throw new ShopgoodwillError(
          `${message}: Shopgoodwill did not answer with JSON`,
          res.status
        );
      }
      throw new ShopgoodwillUnavailableError(
        name === "TimeoutError"
          ? `${message}: Shopgoodwill did not finish answering within ${this.REQUEST_TIMEOUT_MS} ms`
          : `${message}: the connection to Shopgoodwill was lost`,
        res.status,
        { cause: error }
      );
    }
    if (typeof body !== "object" || body === null) {
      throw new ShopgoodwillError(
        `${message}: unexpected response`,
        res.status
      );
    }
    return body as { [key: string]: unknown };
  };

  public get = async (path: string): Promise<ShopgoodwillApiResponse> =>
    this.request(path);

  public post = async (
    path: string,
    options?: RequestInit
  ): Promise<ShopgoodwillApiResponse> =>
    this.request(path, { method: "POST", ...options });

  /**
   *  Simple function to test an access token by looking at the user's saved searches
   */
  public access_token_is_valid = async (
    access_token: string
  ): Promise<boolean> => {
    this.shopgoodwill_session_headers[
      "Authorization"
    ] = `Bearer ${access_token}`;

    const res = await this.post("/SaveSearches/GetSaveSearches");
    if (res.status === 200) {
      return true;
    }

    delete this.shopgoodwill_session_headers["Authorization"];
    if (res.status === 401 || res.status === 403) {
      // Expired or revoked: the caller logs in again
      return false;
    }
    throw httpError("Could not check the access token", res.status);
  };

  /**
   * Raise an exception if an endpoint requiring login is called without valid auth
   */
  private check_auth = (): boolean => {
    if (!this.shopgoodwill_session_headers["Authorization"]) {
      throw new ShopgoodwillAuthError(
        "Not authenticated: call and await authenticate() first"
      );
    }
    return true;
  };

  /**
   * Do the login request
   */
  public login = async (
    username: string,
    password: string
  ): Promise<boolean> => {
    const login_params = {
      browser: "firefox",
      remember: this.auth_info.remember ?? false,
      clientIpAddress: this.CLIENT_IP_ADDRESS,
      appVersion: "00099a1be3bb023ff17d",
      username: username,
      password: password,
    };

    const res = await this.post("/SignIn/Login", {
      body: JSON.stringify(login_params),
    });

    if (!res.ok) {
      throw httpError("Login failed", res.status, true);
    }

    await this.take_tokens(await this.read_json(res, "Login failed"), "Login failed");
    return true;
  };

  public get_saved_searches = async (): Promise<SavedSearch[]> => {
    this.check_auth();
    const res = await this.post("/SaveSearches/GetSaveSearches");
    if (!res.ok) {
      throw httpError("Could not load saved searches", res.status);
    }

    const searches = (await this.read_json(res, "Could not load saved searches"))["data"];
    if (!Array.isArray(searches)) {
      throw new ShopgoodwillError(
        "Could not load saved searches: unexpected response",
        res.status
      );
    }
    return searches as SavedSearch[];
  };

  /**
   * Returns the logged in user's favorites, and all of their (visible) attributes.
   */
  public get_favorites = async (
    favorite_type: "all" | "open" | "closed" = "open"
  ): Promise<ShopgoodwillFavorite[]> => {
    this.check_auth();
    const res = await this.post(
      `/Favorite/GetAllFavoriteItemsByType?Type=${favorite_type}`,
      {
        body: JSON.stringify({}),
      }
    );

    if (!res.ok) {
      throw httpError("Could not load favorites", res.status);
    }

    const favorites = (await this.read_json(res, "Could not load favorites"))["data"];
    if (!Array.isArray(favorites)) {
      throw new ShopgoodwillError(
        "Could not load favorites: unexpected response",
        res.status
      );
    }
    // The API sends Pacific wall-clock strings with no offset; hand callers
    // real instants, which is also what ShopgoodwillFavorite declares. An
    // unreadable time becomes an Invalid Date for the caller to deal with,
    // rather than one bad item failing the whole list.
    return (favorites as ShopgoodwillFavorite[]).map((favorite) => ({
      ...favorite,
      startTime: shopgoodwillTimeToDate(favorite.startTime),
      endTime: shopgoodwillTimeToDate(favorite.endTime),
    }));
  };

  /**
   *  Given an Item ID, attempt to add it to the logged in user's favorites, optionally with a note.
   */
  public add_favorite = async (
    item_id: number,
    note?: string
  ): Promise<void> => {
    this.check_auth();
    const res = await this.get(`/Favorite/AddToFavorite?itemId=${item_id}`);
    if (!res.ok) {
      throw httpError(`Could not add item ${item_id} to favorites`, res.status);
    }

    if (note) {
      await this.add_favorite_note(item_id, note);
    }
  };

  /**
   *  Given an Item ID of an item in the logged in user's favorites, add the requested note to it.
   */
  public add_favorite_note = async (
    item_id: number,
    note: string
  ): Promise<void> => {
    this.check_auth();
    if (note.length > this.FAVORITES_MAX_NOTE_LENGTH) {
      note = note.substring(0, this.FAVORITES_MAX_NOTE_LENGTH);
    }

    const favorites = await this.get_favorites();
    const filteredFavorite = favorites.filter(
      (item) => item.itemId === item_id
    );
    if (filteredFavorite.length) {
      const watchlist_id = filteredFavorite[0].watchlistId;
      const res = await this.post("/Favorite/Save", {
        body: JSON.stringify({
          notes: note,
          watchlistId: watchlist_id,
        }),
      });
      if (!res.ok) {
        throw httpError(`Could not save the note on item ${item_id}`, res.status);
      }
    } else {
      throw new ShopgoodwillError(`Item ${item_id} is not in the favorites`);
    }
  };
}

export default Shopgoodwill;
