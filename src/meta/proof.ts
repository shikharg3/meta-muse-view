import { createHmac } from "node:crypto";

/** Meta `appsecret_proof`: HMAC-SHA256 of the access token, keyed by the app secret, hex. */
export function appsecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}
