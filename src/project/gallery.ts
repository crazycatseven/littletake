/** Gallery viewers load the shared image; they never download or render another project's scene. */
export function loadProjectCovers(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-project-cover]').forEach(card => {
    const img = card.querySelector<HTMLImageElement>('img')!, url = img.dataset.coverUrl;
    if (!url) return;
    img.onload = () => { card.dataset.previewState = 'ready'; };
    img.onerror = () => {
      card.dataset.previewState = 'error';
      card.querySelector<HTMLElement>('[data-preview-label]')!.textContent = 'Preview unavailable';
    };
    img.src = url;
  });
}

export function retryProjectCover(card: HTMLElement): void {
  card.dataset.previewState = 'loading';
  card.querySelector<HTMLElement>('[data-preview-label]')!.textContent = 'Loading preview…';
  const img = card.querySelector<HTMLImageElement>('img')!;
  img.src = img.dataset.coverUrl + '&retry=' + Date.now();
}
