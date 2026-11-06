/**
 * The transfer protocol policy: bulk file work prefers FTP; single reads keep the profile's
 * protocol; writes are FTP only; a login refusal is a fallback reason for reads.
 */
import { protocolOrder } from '@core/live/protocol';
import { isFtpAuthFailure } from '@core/live/connectionHints';

export async function run(check: (cond: unknown, msg: string) => void): Promise<void> {
  const order = (o: Parameters<typeof protocolOrder>[0]) => protocolOrder(o).join(',');

  check(order({ useFtp: false, bulk: true, write: false, preferFtp: true }) === 'ftp,http',
    'protocol: a bulk transfer prefers FTP even when the profile uses HTTP for single reads');
  check(order({ useFtp: true, bulk: true, write: false, preferFtp: true, sticky: 'http' }) === 'ftp,http',
    'protocol: bulk ignores a sticky HTTP fallback and tries FTP again');
  check(order({ useFtp: false, bulk: true, write: false, preferFtp: false }) === 'http,ftp',
    'protocol: with preferFtp off, a bulk transfer follows the profile protocol');
  check(order({ useFtp: true, bulk: true, write: false, preferFtp: false }) === 'ftp,http',
    'protocol: with preferFtp off, a bulk transfer follows an FTP profile');
  check(order({ useFtp: true, bulk: false, write: false, preferFtp: true, sticky: 'http' }) === 'http,ftp',
    'protocol: a single read keeps the sticky last-good transport');
  check(order({ useFtp: true, bulk: false, write: false, preferFtp: true }) === 'ftp,http',
    'protocol: a single read follows the profile preference with no sticky value');
  check(order({ useFtp: false, bulk: true, write: true, preferFtp: true }) === 'ftp',
    'protocol: a write is FTP only');

  check(isFtpAuthFailure(new Error('FTP login failed: 530 Login incorrect')), 'protocol: 530 is a login refusal');
  check(isFtpAuthFailure('FTP PASS failed: 530'), 'protocol: a 530 in a PASS reply is a login refusal');
  check(!isFtpAuthFailure(new Error('timeout after 30000 ms')), 'protocol: a timeout is not a login refusal');
  check(!isFtpAuthFailure(new Error('FTP RETR failed: 550 No such file')), 'protocol: a missing file is not a login refusal');
}
