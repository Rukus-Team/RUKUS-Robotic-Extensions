/**
 * Robot passwords RUKUS encrypted in a cluster file (a cluster with "Encrypt robot passwords"
 * on): "dpapi:v1:" + Base64 of Windows DPAPI, CurrentUser scope, entropy "RUKUS robot password
 * v1" (RUKUS.Core/Helpers/RobotPasswordProtector.cs). Only the Windows account that saved the
 * file can read them - the same account VS Code runs as on that PC.
 *
 * Node has no DPAPI, so Windows PowerShell does it: every value in one call, the ciphertexts on
 * stdin and the answers back as Base64 (so a password in any language survives the console's
 * code page). A value this account cannot read comes back undefined - another account or PC
 * encrypted it - and the caller carries on without it, as RUKUS does.
 */
import { execFile, execFileSync } from 'node:child_process';

export const DPAPI_PREFIX = 'dpapi:v1:';
export const DPAPI_ENTROPY = 'RUKUS robot password v1';

export const isProtected = (v: unknown): v is string => typeof v === 'string' && v.startsWith(DPAPI_PREFIX);

/**
 * PowerShell: one Base64 ciphertext per line on stdin -> one Base64 plaintext per line, "-" for
 * one this account cannot read. Lines, not JSON: Windows PowerShell 5.1's ConvertFrom-Json hands a
 * JSON array back as ONE object, which turned a batch of two into one unreadable item.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')
foreach ($b in ([Console]::In.ReadToEnd() -split '\\r?\\n' | Where-Object { $_ })) {
  try { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($b), $entropy, 'CurrentUser')) }
  catch { '-' }
}
`;

const encodedCommand = () => Buffer.from(SCRIPT, 'utf16le').toString('base64');
const ARGS = () => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand()];

function parse(values: readonly string[], stdout: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  // only answer lines: Base64 or "-" (PowerShell's progress noise goes to stderr, but be sure)
  const answers = stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l === '-' || /^[A-Za-z0-9+/]+=*$/.test(l));
  const complete = answers.length === values.length;
  values.forEach((v, i) => {
    const a = complete ? answers[i] : '-';
    out.set(v, a && a !== '-' ? Buffer.from(a, 'base64').toString('utf8') : undefined);
  });
  return out;
}

const payload = (values: readonly string[]) => values.map(v => v.slice(DPAPI_PREFIX.length)).join('\n') + '\n';

/** Each encrypted value -> its password, or undefined when this account cannot read it. Plain values are left out. */
export async function unprotectAll(values: readonly string[]): Promise<Map<string, string | undefined>> {
  const enc = [...new Set(values.filter(isProtected))];
  if (!enc.length) return new Map();
  if (process.platform !== 'win32') return new Map(enc.map(v => [v, undefined]));
  const stdout = await new Promise<string>(resolve => {
    const child = execFile('powershell.exe', ARGS(), { windowsHide: true, timeout: 20_000, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? '' : String(out)));
    child.stdin?.end(payload(enc));
  });
  return parse(enc, stdout);
}

/** The same, blocking - for the tests. */
export function unprotectAllSync(values: readonly string[]): Map<string, string | undefined> {
  const enc = [...new Set(values.filter(isProtected))];
  if (!enc.length) return new Map();
  if (process.platform !== 'win32') return new Map(enc.map(v => [v, undefined]));
  let stdout = '';
  try { stdout = execFileSync('powershell.exe', ARGS(), { input: payload(enc), windowsHide: true, timeout: 20_000 }).toString(); } catch { /* unreadable */ }
  return parse(enc, stdout);
}

/** A password as RUKUS stored it -> usable: plain as it is; encrypted from the map unprotectAll made; unreadable -> undefined. */
export function resolvePassword(stored: string | undefined, decrypted: Map<string, string | undefined>): string | undefined {
  if (!stored) return undefined;
  return isProtected(stored) ? decrypted.get(stored) : stored;
}
