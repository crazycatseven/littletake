import { evaluateAsset } from './model';
import './panel.css';
import { validateAsset, type AssetDefinition } from './model';

export class AssetPanel {
  private list = document.createElement('div');
  private feedback = document.createElement('p');
  private revision = 0;
  constructor(root: HTMLElement, private context: () => AssetDefinition[], private place: (asset: AssetDefinition) => void, private edit?: (asset: AssetDefinition) => void) {
    const title = document.createElement('p'); title.className = 'library-caption'; title.textContent = 'Reusable assets';
    const refresh = document.createElement('button'); refresh.textContent = 'Refresh library'; refresh.addEventListener('click', () => void this.refresh());
    this.list.className = 'asset-library-cards'; this.feedback.className = 'library-caption';
    root.append(title, refresh, this.feedback, this.list); void this.refresh();
  }
  async refresh() {
    const revision = ++this.revision; this.feedback.textContent = 'Loading library…';
    try {
      const response = await fetch('/api/assets'); if (!response.ok) throw new Error('Library unavailable. Project assets are still saved.');
      const data = await response.json(), assets: AssetDefinition[] = data.assets.map(validateAsset);
      for (const asset of this.context()) if (!assets.some(a => a.id === asset.id && a.version === asset.version)) assets.push(asset);
      if (revision !== this.revision) return;
      this.list.replaceChildren(); this.feedback.textContent = `${assets.length} assets · Ask Muse to create anything missing`;
      for (const asset of assets) {
        const button = document.createElement('button'); button.className = 'asset-library-card'; button.setAttribute('aria-label', 'Add asset ' + asset.name);
        const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.src = `/api/assets?id=${encodeURIComponent(asset.id)}&version=${asset.version}&preview=1`;
        const title = document.createElement('strong'); title.textContent = asset.name;
        const details = document.createElement('span'); details.textContent = `${evaluateAsset(asset).parts.filter(p=>p.kind!=='group').length} parts · ${asset.bounds.size.map(n => n.toFixed(2)).join(' × ')} m`;
        const version = document.createElement('span'); version.textContent = 'v' + asset.version;
        button.append(image, title, details, version); button.addEventListener('click', () => this.place(asset));
        const entry = document.createElement('div'); entry.className = 'asset-library-entry'; entry.append(button);
        if (this.edit) { const edit = document.createElement('button'); edit.className = 'asset-edit-button'; edit.textContent = '打开资产编辑器'; edit.setAttribute('aria-label', `编辑资产 ${asset.name} v${asset.version}`); edit.onclick = () => this.edit!(asset); entry.append(edit); }
        this.list.append(entry);
      }
    } catch (error) { if (revision === this.revision) this.feedback.textContent = error instanceof Error ? error.message : 'Library unavailable.'; }
  }
}
