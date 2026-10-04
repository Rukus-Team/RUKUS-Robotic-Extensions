/**
 * The likely cause of a failed robot request, in words a cell engineer can act on. Shared by
 * the robot form's Test button, Connect, and the push messages, so a robot that cannot be
 * reached says the same thing wherever it shows up. undefined when nothing specific is known.
 */
export function connectionHint(err: string, p: { useFtp: boolean }): string | undefined {
  if (/ECONNREFUSED/.test(err)) return p.useFtp ? 'Port refused. Is FTP enabled on the controller (MENU → SETUP → Host Comm → FTP)?' : 'Port refused. Is the web server enabled (MENU → SETUP → Host Comm → HTTP)? Try FTP instead.';
  if (/timeout|timed out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(err)) return 'No answer. Check the IP, that the PC is on the robot network, and that you can ping the controller.';
  if (/ENOTFOUND|EAI_AGAIN/.test(err)) return 'Host name not found. Use the IP address.';
  if (/ECONNRESET|socket hang up|EPIPE|FTP connection closed/i.test(err)) return 'The controller dropped the connection mid-transfer - its web server may be busy or stuck. Try again, or switch the robot to FTP.';
  if (/HTTP 4\d\d/.test(err)) return 'The web server answered but refused the file. Some controllers need "HTTP Authentication" set to allow the MD: device, or use FTP.';
  if (/\b530\b|login|PASS/i.test(err)) return 'FTP login failed. Check user/password (blank user + blank password is common on FANUC).';
  if (/program is in use/i.test(err)) return 'The program is selected, running or paused on the controller. Abort it on the pendant (FCTN, ABORT ALL) or select another program, then push again.';
  if (/protection error/i.test(err)) return 'The program is write-protected on the controller (PROTECT = READ). Turn Write protect OFF on the pendant (SELECT, the program, DETAIL), then push again.';
  // 55x on an upload is the controller refusing the program; on a read it only means "no such file"
  if (/STOR failed: 55[0-3]\b/.test(err)) return 'The controller refused the file: usually the program is selected or running on the pendant, write-protected, or the controller has neither Ascii Upload (R507) nor Ascii Program Loader (R796).';
  if (/(RETR|SIZE) failed: 550\b/.test(err)) return 'The controller has no file of that name on that device.';
  return undefined;
}
