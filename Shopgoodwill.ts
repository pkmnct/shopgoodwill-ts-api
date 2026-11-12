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

/** Shopgoodwill refused the login or the session (HTTP 400/401/403, or no token). Sign in again, check the credentials. */
export class ShopgoodwillAuthError extends ShopgoodwillError {}

/**
 * Shopgoodwill could not be reached or is failing (network error, timeout,
 * HTTP 5xx or 429). Says nothing about the credentials: retry later.
 */
export class ShopgoodwillUnavailableError extends ShopgoodwillError {}

const isUnavailableStatus = (status: number) => status >= 500 || status === 429;

/** The right error class for an unsuccessful response. */
const httpError = (message: string, status: number): ShopgoodwillError => {
  const text = `${message}: Shopgoodwill returned HTTP ${status}`;
  if (status === 400 || status === 401 || status === 403) {
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
}

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

  private shopgoodwill_session_headers: { [key: string]: string } = {
    "Content-Type": "application/json",
    Origin: "https://shopgoodwill.com",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 6.1; WOW64; rv:12.0) Gecko/20100101 Firefox/12.0",
  };
  private auth_info: AuthInfo;

  /**
   * Stores the credentials only. Call `authenticate()` and await it before
   * using endpoints that need a login.
   */
  constructor(auth_info: AuthInfo) {
    this.auth_info = auth_info;
  }

  public authenticate = async () => {
    if (this.auth_info) {
      if (
        this.auth_info.accessToken &&
        (await this.access_token_is_valid(this.auth_info.accessToken))
      ) {
        this.shopgoodwill_session_headers[
          "Authorization"
        ] = `Bearer ${this.auth_info.accessToken}`;
      } else {
        if (
          this.auth_info.encryptedUsername &&
          this.auth_info.encryptedPassword
        ) {
          await this.login(
            this.auth_info.encryptedUsername,
            this.auth_info.encryptedPassword
          );
        } else if (this.auth_info.userName && this.auth_info.password) {
          await this.login(
            this.encrypt_login_value(this.auth_info.userName),
            this.encrypt_login_value(this.auth_info.password)
          );
        } else {
          throw new Error("Invalid auth_info");
        }
      }
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
    if (res.status === 401) {
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
      throw new Error("Not authenticated");
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
      remember: false,
      clientIpAddress: "0.0.0.4",
      appVersion: "00099a1be3bb023ff17d",
      username: username,
      password: password,
    };

    const res = await this.post("/SignIn/Login", {
      body: JSON.stringify(login_params),
    });

    if (!res.ok) {
      throw httpError("Login failed", res.status);
    }

    const resJson = await res.json();
    const token = resJson["accessToken"];

    if (token) {
      this.auth_info.accessToken = token as string;
      this.shopgoodwill_session_headers[
        "Authorization"
      ] = `Bearer ${this.auth_info.accessToken}`;

      return true;
    } else {
      throw new ShopgoodwillAuthError("Login failed: no access token in the response");
    }
  };

  public get_saved_searches = async (): Promise<SavedSearch[]> => {
    this.check_auth();
    const res = await this.post("/SaveSearches/GetSaveSearches");

    return (await res.json())["data"] as SavedSearch[];
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

    const favorites = (await res.json())["data"];
    if (!Array.isArray(favorites)) {
      throw new ShopgoodwillError("Could not load favorites: unexpected response");
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
    await this.get(`/Favorite/AddToFavorite?itemId=${item_id}`);

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
      await this.post("/Favorite/Save", {
        body: JSON.stringify({
          notes: note,
          watchlistId: watchlist_id,
        }),
      });
    } else {
      throw new Error(`Item ${item_id} not in user's favorites!`);
    }
  };
}

export default Shopgoodwill;
