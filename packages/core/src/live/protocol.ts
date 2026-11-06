/**
 * Which transport a transfer should try, in order.
 *
 * Bulk file work (folder fetch/pull, backup, snapshot-from-robot, compare-all, a single-file
 * fetch/pull) prefers FTP even when the robot profile uses HTTP for single reads: a controller's
 * cost is per session, not per byte, and one FTP session beats one HTTP GET per file.
 *
 * Pure, so the policy is unit-tested without a controller.
 */
import type { TransferProtocol } from './types';

export interface ProtocolChoice {
  /** the profile preference, used for single reads */
  useFtp: boolean;
  bulk: boolean;
  /** writes are FTP only */
  write: boolean;
  /** robotCode.transfers.preferFtp */
  preferFtp: boolean;
  /** the last transport that worked for this robot (ignored for bulk) */
  sticky?: TransferProtocol;
}

export function protocolOrder(o: ProtocolChoice): TransferProtocol[] {
  if (o.write) return ['ftp'];
  if (o.bulk && o.preferFtp) return ['ftp', 'http'];
  const preferred: TransferProtocol = o.useFtp ? 'ftp' : 'http';
  const first = o.sticky ?? preferred;
  return first === 'ftp' ? ['ftp', 'http'] : ['http', 'ftp'];
}
