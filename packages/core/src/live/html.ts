/**
 * The controller web server wraps text files (.DG/.VA/.LS…) in its homepage HTML
 * template, with the payload inside <PRE> … </PRE> - or, on some controller versions,
 * a bare <XMP> … </XMP> with no page around it. Either container is unwrapped.
 * Verified against R-30iB Plus V9.40 (ROBOGUIDE virtual controllers) and field reports.
 */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 400).trimStart().toLowerCase();
  return head.startsWith('<html') || head.startsWith('<!doctype html') || /^<head|^<meta|^<xmp/.test(head);
}

export function unwrapControllerHtml(text: string): string {
  // <PRE> on the homepage template, a bare <XMP> on firmware that serves the payload with no
  // page around it - and sometimes BOTH, the program inside <PRE><XMP>…</XMP></PRE>. Peel
  // containers off repeatedly rather than once, so a nested wrapper is fully removed; the
  // opening tag is found wherever it sits, and a plain controller file has neither tag.
  let body = text;
  let found = false;
  for (let i = 0; i < 8; i++) {
    const open = /<(pre|xmp)[^>]*>/i.exec(body);
    if (!open) break;
    found = true;
    const tag = open[1].toLowerCase();
    const rest = body.slice(open.index + open[0].length);
    const close = new RegExp(`</${tag}\\s*>`, 'i').exec(rest);
    body = close ? rest.slice(0, close.index) : rest;
    // The <XMP> wrapper brackets the payload with a newline on each side, so the one before
    // </XMP> is the wrapper's, not the file's - drop it or every fetch gains a trailing blank line.
    if (tag === 'xmp') body = body.replace(/\r?\n$/, '');
  }
  if (found) return decodeEntities(body).replace(/^\r?\n/, '');
  if (!looksLikeHtml(text)) return text;
  // an HTML page with no <pre>/<xmp>: strip tags
  return decodeEntities(text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ''));
}

export function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#39|nbsp|#(\d+));/g, (_, k: string, num?: string) => {
    switch (k) { case 'lt': return '<'; case 'gt': return '>'; case 'amp': return '&'; case 'quot': return '"'; case 'apos': case '#39': return "'"; case 'nbsp': return ' '; }
    return num ? String.fromCharCode(parseInt(num, 10)) : _;
  });
}

/** Text-like controller files that the web server wraps in HTML */
export function isTextFile(name: string): boolean {
  return /\.(ls|va|dg|dt|cm|cf|txt|io|htm|html|stm|csv|log|xml|kl|tx|ftx|utx)$/i.test(name);
}
