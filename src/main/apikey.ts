// The Anthropic API key, for people who use Poupou without a Claude
// subscription. Encrypted with the operating system's own store (DPAPI on
// Windows, the Keychain on macOS) before it touches the disk, and it never
// goes to the island or the settings page — they only learn that a key exists
// and its last four characters.

import Anthropic from "@anthropic-ai/sdk";
import { safeStorage } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, log } from "./store";

const keyFile = () => join(dataDir(), "api-key.bin");

export interface ApiKeyStatus {
  present: boolean;
  /** "…a1B2" — enough to recognise which key it is. */
  hint: string | null;
}

export function getApiKey(): string | null {
  try {
    if (!existsSync(keyFile())) return null;
    return safeStorage.decryptString(readFileSync(keyFile()));
  } catch (err) {
    log(`could not read the saved API key: ${String(err)}`);
    return null;
  }
}

export function apiKeyStatus(): ApiKeyStatus {
  const key = getApiKey();
  return { present: key != null, hint: key ? `…${key.slice(-4)}` : null };
}

/** Checks the key against the API (listing models costs nothing), then stores it. */
export async function setApiKey(raw: string): Promise<ApiKeyStatus> {
  const key = raw.trim();
  if (!key) throw new Error("Paste a key first.");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("This computer has no secure storage available, so the key can't be saved safely.");
  }
  try {
    await new Anthropic({ apiKey: key, maxRetries: 1, timeout: 20_000 }).models.list({ limit: 1 });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("That key was rejected by Anthropic. Check it and try again.");
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error("That key isn't allowed to use the API.");
    if (err instanceof Anthropic.APIConnectionError) throw new Error("Couldn't reach Anthropic to check the key — are you online?");
    throw new Error(`Couldn't check the key: ${err instanceof Error ? err.message : String(err)}`);
  }
  writeFileSync(keyFile(), safeStorage.encryptString(key));
  log("API key saved");
  return apiKeyStatus();
}

export function clearApiKey(): ApiKeyStatus {
  rmSync(keyFile(), { force: true });
  log("API key removed");
  return apiKeyStatus();
}
