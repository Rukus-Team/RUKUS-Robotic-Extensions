/**
 * What the Files panel shows of a device listing. Pure, so the corpus test can pin it.
 *
 * `programs` (the default) is the TP programs only: every `.ls`, and a `.tp` only where no
 * `.ls` of that name is on the device - the controller writes both for every program it
 * exported as text, and listing both doubled the panel. `all` is everything the panel used
 * to show (data files too). Display only: the full listing still resolves CALLs and feeds
 * the backup pull.
 */
import type { RemoteFile } from './types';

export type FilesShow = 'programs' | 'all';

export function filesToShow(files: RemoteFile[], mode: FilesShow | string): RemoteFile[] {
  if (mode !== 'programs') return files.filter(f => f.isDir || /\.(ls|va|dg|kl|pc|tp|cm|txt|dt|io)$/i.test(f.name));
  const stem = (name: string) => name.replace(/\.[^.]*$/, '').toUpperCase();
  const hasLs = new Set(files.filter(f => !f.isDir && /\.ls$/i.test(f.name)).map(f => stem(f.name)));
  return files.filter(f => f.isDir || /\.ls$/i.test(f.name) || (/\.tp$/i.test(f.name) && !hasLs.has(stem(f.name))));
}
