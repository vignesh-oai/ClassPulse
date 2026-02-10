import { createHash, randomBytes } from "node:crypto";

export type PkceCodes = {
  codeVerifier: string;
  codeChallenge: string;
};

export function generatePkce(): PkceCodes {
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function base64UrlEncode(buffer: Buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
