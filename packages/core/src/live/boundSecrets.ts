/**
 * Secrets kept for a controller profile (an FTP or RWS password, a station PIN) are bound to the
 * host they were saved for. Profiles are found by name, and a workspace can define a profile of
 * the same name with another host; a secret read for the wrong host would go to that host. So a
 * secret comes back only for the host it was saved with, and a host change asks for it again.
 *
 * A secret saved before hosts were bound (or saved before the profile had a host) is bound to the
 * host it is first read for.
 */
import type * as vscode from 'vscode';

const hostKey = (key: string) => `${key}.host`;
const sameHost = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export async function getBoundSecret(secrets: vscode.SecretStorage, key: string, host: string | undefined): Promise<string | undefined> {
  const value = await secrets.get(key);
  if (value === undefined) return undefined;
  const bound = await secrets.get(hostKey(key));
  if (bound === undefined) {
    if (host) await secrets.store(hostKey(key), host.trim());
    return value;
  }
  return host !== undefined && sameHost(bound, host) ? value : undefined;
}

export async function storeBoundSecret(secrets: vscode.SecretStorage, key: string, value: string, host: string | undefined): Promise<void> {
  await secrets.store(key, value);
  if (host) await secrets.store(hostKey(key), host.trim());
  else await secrets.delete(hostKey(key));
}

export async function deleteBoundSecret(secrets: vscode.SecretStorage, key: string): Promise<void> {
  await secrets.delete(key);
  await secrets.delete(hostKey(key));
}
