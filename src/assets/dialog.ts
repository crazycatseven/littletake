import { assetCatalogSchema, emptyCatalog, folderLabel, folderPathSchema, parentFolder, type AssetCatalog } from './folders';
import { validateAsset, type AssetDefinition } from './model';

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
export async function assetRequest(input: unknown): Promise<any> {
  const response = await fetch('/api/assets', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(input) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? 'Could not save to the asset library. Please retry.');
  return data;
}
async function loadCatalog(): Promise<AssetCatalog> {
  const response = await fetch('/api/assets'); if (!response.ok) throw new Error('Could not load folders. Refresh the library and retry.');
  return assetCatalogSchema.parse((await response.json()).catalog ?? emptyCatalog());
}
function errorText(dialog: HTMLDialogElement, error?: unknown) {
  const node = dialog.querySelector<HTMLElement>('[role="alert"]')!;
  node.textContent = error instanceof Error ? error.message : ''; node.hidden = !error;
}
function modal<T>(dialog: HTMLDialogElement, submit: () => Promise<T>): Promise<T | undefined> {
  return new Promise(resolve => {
    let busy = false, result: T | undefined;
    dialog.querySelector<HTMLFormElement>('form')!.onsubmit = async event => {
      event.preventDefault(); if (busy) return; busy = true; errorText(dialog);
      const fields = [...dialog.querySelectorAll<HTMLInputElement>('input,select,button')], disabled = fields.map(field => field.disabled);
      fields.forEach(field => { field.disabled = true; }); dialog.setAttribute('aria-busy','true');
      try { result = await submit(); dialog.close(); }
      catch (error) { errorText(dialog, error); }
      finally { busy = false; fields.forEach((field,i) => { field.disabled = disabled[i]; }); dialog.removeAttribute('aria-busy'); }
    };
    dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = () => dialog.close();
    dialog.oncancel = event => { if (busy) event.preventDefault(); };
    dialog.onclose = () => { dialog.remove(); resolve(result); };
    document.body.append(dialog); dialog.showModal();
  });
}

/** Both Hierarchy entrances and Prefab Mode use the same name/folder creation flow. */
export function createPrefabDialog(asset: AssetDefinition, folder = ''): Promise<{asset: AssetDefinition; folder: string} | undefined> {
  const dialog = document.createElement('dialog'); dialog.className = 'asset-create-dialog'; dialog.setAttribute('aria-label','Create independent prefab');
  dialog.innerHTML = `<form><div class="dialog-heading"><h2>Create Prefab</h2></div><p>Save a reusable asset in My Assets.</p><label>Prefab name<input aria-label="Prefab name" maxlength="120" value="${esc(asset.name)}" required/></label><label>Folder<select aria-label="Asset folder" disabled><option value="${esc(folder)}">${esc(folderLabel(folder))}</option></select></label><button type="button" data-new-folder>＋ New Folder</button><div class="asset-new-folder" hidden><label>Folder name<input aria-label="New folder name" maxlength="80" placeholder="e.g. Cabinets"/></label><button type="button" data-create-folder>Create Folder</button></div><p role="alert" hidden></p><div class="change-actions"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary-button" disabled>Create Prefab</button></div></form>`;
  const name = dialog.querySelector<HTMLInputElement>('[aria-label="Prefab name"]')!, select = dialog.querySelector<HTMLSelectElement>('select')!, save = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const newFolder = dialog.querySelector<HTMLButtonElement>('[data-new-folder]')!; newFolder.disabled = true;
  const setFolders = (catalog: AssetCatalog, selected: string) => {
    select.innerHTML = ['',...catalog.folders].map(path => `<option value="${esc(path)}">${esc(folderLabel(path))}</option>`).join('');
    select.value = catalog.folders.includes(selected) ? selected : ''; select.disabled = save.disabled = newFolder.disabled = false;
  };
  dialog.querySelector<HTMLButtonElement>('[data-new-folder]')!.onclick = () => {
    const row = dialog.querySelector<HTMLElement>('.asset-new-folder')!; row.hidden = !row.hidden;
    if (!row.hidden) row.querySelector('input')!.focus();
  };
  dialog.querySelector<HTMLButtonElement>('[data-create-folder]')!.onclick = async () => {
    const field = dialog.querySelector<HTMLInputElement>('[aria-label="New folder name"]')!, button = dialog.querySelector<HTMLButtonElement>('[data-create-folder]')!;
    try {
      if (!field.value.trim()) throw new Error('Enter a folder name.');
      const path = folderPathSchema.parse([select.value,field.value.trim()].filter(Boolean).join('/'));
      button.disabled = save.disabled = true;
      const data = await assetRequest({action:'create_folder',folder:path}); setFolders(assetCatalogSchema.parse(data.catalog),path);
      field.value = ''; dialog.querySelector<HTMLElement>('.asset-new-folder')!.hidden = true; errorText(dialog);
    } catch (error) { errorText(dialog,error); }
    finally { button.disabled = save.disabled = false; }
  };
  dialog.querySelector<HTMLInputElement>('[aria-label="New folder name"]')!.onkeydown = event => {
    if(event.key==='Enter'){event.preventDefault();dialog.querySelector<HTMLButtonElement>('[data-create-folder]')!.click();}
  };
  const result = modal(dialog, async () => {
    const next = validateAsset({...asset,name:name.value.trim()});
    const data = await assetRequest({action:'register',asset:next,folder:select.value});
    return {asset:validateAsset(data.asset),folder:select.value};
  });
  void loadCatalog().then(catalog => { if (dialog.isConnected) setFolders(catalog,folder); }).catch(error => errorText(dialog,error));
  name.focus(); name.select(); return result;
}

export function editFolderDialog(parent = '', rename?: string): Promise<{catalog:AssetCatalog; folder:string} | undefined> {
  const dialog = document.createElement('dialog'); dialog.className = 'asset-create-dialog'; dialog.setAttribute('aria-label',rename ? 'Rename folder' : 'New folder');
  if (rename) parent = parentFolder(rename);
  dialog.innerHTML = `<form><div class="dialog-heading"><h2>${rename?'Rename Folder':'New Folder'}</h2></div><p>${esc(folderLabel(parent))}</p><label>Folder name<input aria-label="Folder name" maxlength="80" value="${esc(rename?.split('/').at(-1) ?? '')}" required/></label><p role="alert" hidden></p><div class="change-actions"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary-button">${rename?'Rename Folder':'Create Folder'}</button></div></form>`;
  const name = dialog.querySelector('input')!;
  const result = modal(dialog,async () => {
    if (!name.value.trim()) throw new Error('Enter a folder name.');
    const folder = folderPathSchema.parse([parent,name.value.trim()].filter(Boolean).join('/'));
    const data = await assetRequest(rename ? {action:'rename_folder',from:rename,to:folder} : {action:'create_folder',folder});
    return {catalog:assetCatalogSchema.parse(data.catalog),folder};
  }); name.focus(); name.select(); return result;
}
