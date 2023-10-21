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
  private logged_in = false;
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

  public get = async (path: string): Promise<Response> =>
    await fetch(this.API_ROOT + path, {
      headers: this.shopgoodwill_session_headers,
    });

  public post = async (
    path: string,
    options?: RequestInit
  ): Promise<Response> =>
    await fetch(this.API_ROOT + path, {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      headers: this.shopgoodwill_session_headers,
      method: "POST",
      ...options,
    });

  public access_token_is_valid = async (
    access_token: string
  ): Promise<boolean> => {
    this.logged_in = true;
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

  private check_auth = (): boolean => {
    if (!this.shopgoodwill_session_headers["Authorization"]) {
      throw new Error("Not authenticated");
    }
    return true;
  };

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

    // Ensure the site isn't down?
    await this.get(this.LOGIN_PAGE_URL);

    const res = await this.post("/SignIn/Login", {
      body: JSON.stringify(login_params),
    });

    const resJson = await (res.json() as any);
    const token = resJson["accessToken"];

    if (token) {
      this.auth_info.accessToken = token;
      this.shopgoodwill_session_headers[
        "Authorization"
      ] = `Bearer ${this.auth_info.accessToken}`;

      this.logged_in = true;

      return true;
    } else {
      throw new Error("Login failed");
    }
  };

  public get_saved_searches = async (): Promise<SavedSearch[]> => {
    this.check_auth();
    const res = await this.post("/SaveSearches/GetSaveSearches");

    return ((await res.json()) as any)["data"];
  };

  public get_favorites = async (
    favorite_type: "all" | "open" | "closed"
  ): Promise<ShopgoodwillFavorite[]> => {
    this.check_auth();
    const res = await this.post(
      `/Favorite/GetAllFavoriteItemsByType?Type=${favorite_type}`,
      {
        body: JSON.stringify({}),
      }
    );

    return ((await res.json()) as any)["data"];
  };
}

export default Shopgoodwill;
