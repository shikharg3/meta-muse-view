import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

function keyBuf(keyHex: string): Buffer {
  const buf = Buffer.from(keyHex, "hex");
  if (buf.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  return buf;
}

/** Returns base64(iv).base64(tag).base64(ciphertext). */
export function encryptSecret(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuf(keyHex), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(blob: string, keyHex: string): string {
  const [ivB64, tagB64, ctB64] = blob.split(".");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", keyBuf(keyHex), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
