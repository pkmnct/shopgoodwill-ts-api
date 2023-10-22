import { ShopgoodwillFavorite } from "./Favorite.ts";
import fetch, { Response } from "node-fetch";
import { createCipheriv } from "crypto";

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

  private shopgoodwill_session_headers: { [key: string]: string } = {
    "Content-Type": "application/json",
    Origin: "https://shopgoodwill.com",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 6.1; WOW64; rv:12.0) Gecko/20100101 Firefox/12.0",
  };
  private auth_info: AuthInfo;

  constructor(auth_info: AuthInfo) {
    this.auth_info = auth_info;
    this.authenticate();
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
    throw new Error(
      "Not yet implemented. Please provide your pre-encrypted username and password"
    );

    // WORKS FOR USERNAME BUT NOT PASSWORD:
    const cipher = createCipheriv(
      "aes-256-cbc",
      this.ENCRYPTION_INFO.key,
      this.ENCRYPTION_INFO.iv
    );

    cipher.update(value);

    return encodeURIComponent(cipher.final("base64"));

    // Original from Python:
    // padded = pad(plaintext.encode(), Shopgoodwill.ENCRYPTION_INFO["block_size"])
    // cipher = AES.new(
    //     Shopgoodwill.ENCRYPTION_INFO["key"],
    //     AES.MODE_CBC,
    //     Shopgoodwill.ENCRYPTION_INFO["iv"],
    // )
    // ciphertext = cipher.encrypt(padded)
    // return urllib.parse.quote(base64.b64encode(ciphertext))
  };

  public get = async (path: string): Promise<ShopgoodwillApiResponse> =>
    (await fetch(this.API_ROOT + path, {
      headers: this.shopgoodwill_session_headers,
    })) as ShopgoodwillApiResponse;

  public post = async (
    path: string,
    options?: RequestInit
  ): Promise<ShopgoodwillApiResponse> =>
    (await fetch(this.API_ROOT + path, {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      headers: this.shopgoodwill_session_headers,
      method: "POST",
      ...options,
    })) as ShopgoodwillApiResponse;

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
      // All good!
    } else {
      delete this.shopgoodwill_session_headers["Authorization"];
      if (res.status !== 401) throw new Error(JSON.stringify(res));
    }

    return true;
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

    const resJson = await res.json();
    const token = resJson["accessToken"];

    if (token) {
      this.auth_info.accessToken = token as string;
      this.shopgoodwill_session_headers[
        "Authorization"
      ] = `Bearer ${this.auth_info.accessToken}`;

      return true;
    } else {
      throw new Error("Login failed");
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

    return (await res.json())["data"] as ShopgoodwillFavorite[];
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
