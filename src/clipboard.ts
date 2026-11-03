/** Clipboard access for both HTTPS and the existing private-network HTTP preview. */
export async function copyText(text: string, host: HTMLElement): Promise<void> {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  const field = document.createElement('textarea'); field.value = text;
  Object.assign(field.style, { position: 'fixed', opacity: '0', pointerEvents: 'none' });
  host.append(field); field.select();
  try { if (!document.execCommand('copy')) throw new Error('Select the text and copy it manually.'); }
  finally { field.remove(); }
}
