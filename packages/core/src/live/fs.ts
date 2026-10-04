/**
 * Read-only file system: fanuc://<robot>/<DEVICE>/<FILE>
 * Lets the editor open programs and dumps straight from the controller and diff them
 * against local copies. Writes are refused (that is the write tier, later).
 */
import * as vscode from 'vscode';
import type { RobotManager } from './robotManager';

export const FANUC_SCHEME = 'fanuc';

export function robotUri(robot: string, device: string, file?: string): vscode.Uri {
  const dev = device.replace(/:$/, '').toUpperCase();
  return vscode.Uri.from({ scheme: FANUC_SCHEME, authority: encodeURIComponent(robot), path: `/${dev}${file ? '/' + file : ''}` });
}

function split(uri: vscode.Uri): { robot: string; device: string; file?: string } {
  const robot = decodeURIComponent(uri.authority);
  const parts = uri.path.split('/').filter(Boolean);
  return { robot, device: (parts[0] ?? 'MD') + ':', file: parts[1] };
}

export class RobotFileSystem implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;
  private readonly cache = new Map<string, { at: number; data: Uint8Array }>();
  constructor(private robots: RobotManager) {}

  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { file } = split(uri);
    if (!file) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const data = await this.readFile(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: data.byteLength, permissions: vscode.FilePermission.Readonly };
  }

  /** URI authorities are lower-cased by VS Code, so match robot names case-insensitively */
  private conn(robot: string) { return this.robots.get(robot) ?? this.robots.list().find(c => c.profile.name.toLowerCase() === robot.toLowerCase()); }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { robot, device } = split(uri);
    const c = this.conn(robot);
    if (!c) throw vscode.FileSystemError.FileNotFound(uri);
    const files = await this.robots.listFiles(c.profile, device);
    return files.map(f => [f.name, f.isDir ? vscode.FileType.Directory : vscode.FileType.File]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { robot, device, file } = split(uri);
    if (!file) throw vscode.FileSystemError.FileIsADirectory(uri);
    const c = this.conn(robot);
    if (!c) throw vscode.FileSystemError.FileNotFound(uri);
    const key = uri.toString();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 1500) return hit.data;
    try {
      const data = await this.robots.readBinary(c.profile, file, device);
      this.cache.set(key, { at: Date.now(), data });
      return data;
    } catch (e: any) {
      throw vscode.FileSystemError.Unavailable(`${robot} ${device}${file}: ${e?.message ?? e}`);
    }
  }

  /** drop cached content so the next open re-reads from the controller */
  invalidate(uri?: vscode.Uri) { if (uri) this.cache.delete(uri.toString()); else this.cache.clear(); }

  createDirectory(): void { throw vscode.FileSystemError.NoPermissions('Robot Code is read-only in this version.'); }
  writeFile(): void { throw vscode.FileSystemError.NoPermissions('Writing to the controller is not enabled in this version (see ROADMAP.md, write tier).'); }
  delete(): void { throw vscode.FileSystemError.NoPermissions('Robot Code is read-only in this version.'); }
  rename(): void { throw vscode.FileSystemError.NoPermissions('Robot Code is read-only in this version.'); }
}
