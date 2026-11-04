import { icon } from '../icons';
import type { SceneObject } from '../types';
import type { Workspace } from '../project/workspace';
import { APPEARANCE_LIMITS, appearanceReference, type AppearanceComponent } from './model';
import { appearanceImage, uploadAppearance } from './images';
import { REFERENCE_IMAGE_DRAG } from '../assets/folders';
import type { OutputTransfer } from '../project/output-upload';
import './inspector.css';

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const componentOf = (item?: SceneObject) => item?.components?.find((c): c is AppearanceComponent => c.type === 'appearanceReference');
export interface AppearanceEditor {
  workspace: Workspace; sceneId: string; item(): SceneObject | undefined; enabled(): boolean; changed(message: string): void; status(message: string): void;
  progress?(name: string, state: OutputTransfer): void;
}

function attachAppearanceIds(options: AppearanceEditor, ids: string[]): void {
  const item = options.item(), room = options.workspace.room;
  if (!item || !room || !options.enabled()) return;
  if (ids.some(id => !room.outputs.some(output => output.id === id && output.kind === 'appearance-reference'))) throw new Error('Choose a reference image from this project’s Assets / References folder.');
  if (ids.some(id => options.workspace.outputTransfer(id))) throw new Error('Finish uploading this image in Assets / References before attaching it.');
  const component = componentOf(item) ?? appearanceReference(), additions = [...new Set(ids)].filter(id => !component.imageIds.includes(id));
  if (!additions.length) { options.status('This reference is already attached.'); return; }
  if (component.imageIds.length + additions.length > APPEARANCE_LIMITS.perObject) throw new Error(`Use up to ${APPEARANCE_LIMITS.perObject} images per object.`);
  if (!componentOf(item)) (item.components ??= []).push(component);
  component.imageIds.push(...additions);
  options.changed(`Appearance references attached to ${item.name}`);
}

export async function attachAppearanceFiles(options: AppearanceEditor, files: File[]): Promise<void> {
  const { workspace } = options, room = workspace.room, item = options.item();
  if (!room || !item || !options.enabled() || !files.length) return;
  const original = componentOf(item), before = JSON.stringify(original);
  if ((original?.imageIds.length ?? 0) + files.length > APPEARANCE_LIMITS.perObject) throw new Error(`Use up to ${APPEARANCE_LIMITS.perObject} images per object.`);
  options.status('Preparing reference images…');
  const ids = await uploadAppearance(workspace, files, options.sceneId, room, options.progress);
  const current = options.item();
  if (workspace.room !== room || !current || !options.enabled() || JSON.stringify(componentOf(current)) !== before) throw new Error('The object changed during upload. Your images are in Assets / References; drag them onto the object to attach.');
  attachAppearanceIds(options, ids);
}

const appearanceDrag = (event: DragEvent) => event.dataTransfer?.types.some(type => type === 'Files' || type === REFERENCE_IMAGE_DRAG);
async function attachAppearanceDrop(options: AppearanceEditor, transfer: DataTransfer): Promise<void> {
  if (transfer.types.includes(REFERENCE_IMAGE_DRAG)) {
    const value = JSON.parse(transfer.getData(REFERENCE_IMAGE_DRAG));
    if (value.project !== options.workspace.room?.id || typeof value.id !== 'string') throw new Error('Use reference images from the current project.');
    attachAppearanceIds(options, [value.id]);
  } else await attachAppearanceFiles(options, [...transfer.files]);
}

/** Bind only media controls here; enable/remove remain owned by the normal component Inspector. */
export function bindAppearanceInspector(root: HTMLElement, options: AppearanceEditor): void {
  const target = root.querySelector<HTMLElement>('[data-appearance-fields]'), component = componentOf(options.item());
  if (!target || !component) return;
  const disabled = !options.enabled() ? 'disabled' : '';
  target.innerHTML = `<div class="appearance-images">${component.imageIds.map((id, index) => `<figure><img draggable="false" data-appearance-image="${id}" alt="${index ? 'Additional appearance reference' : 'Primary appearance reference'}"/><figcaption><button data-appearance-primary="${id}" aria-label="Use image ${index + 1} as primary" ${disabled} ${index ? '' : 'aria-pressed="true"'}>${index ? 'Make primary' : 'Primary'}</button><button data-appearance-remove="${id}" aria-label="Detach image ${index + 1}" title="Detach image" ${disabled}>${icon('close')}</button></figcaption></figure>`).join('')}</div>
    <p class="appearance-empty">Drag images from Assets / References here or onto the object.</p>
    <div class="appearance-actions"><button data-appearance-upload ${disabled}>${icon('upload')} Upload images</button></div><input data-appearance-file type="file" accept="image/png,image/jpeg,image/webp" multiple hidden/>
    <progress data-appearance-progress max="100" value="0" hidden></progress><p data-appearance-message role="status"></p>
    <label>Appearance notes<textarea data-appearance-description aria-label="Appearance notes" maxlength="600" rows="3" placeholder="Features to preserve, e.g. silver armor, red cloak, scar on left cheek." ${disabled}>${esc(component.description)}</textarea></label>
    <small>Primary image sets identity; additional images add detail. Included in Muse and Render. The proxy keeps its geometry and animation.</small>`;
  options = { ...options, progress: (name, state) => {
    if (!target.isConnected) return;
    const progress = target.querySelector<HTMLProgressElement>('[data-appearance-progress]')!, percent = Math.min(100, Math.round(state.loaded / Math.max(1, state.total) * 100));
    progress.hidden = state.phase === 'failed'; progress.value = percent; progress.setAttribute('aria-label', `Uploading ${name}`);
    target.querySelector('[data-appearance-message]')!.textContent = state.phase === 'failed' ? `${name}: upload failed. Retry in Assets / References, then drag the image here.` : state.phase === 'saving' ? `${name}: waiting for server…` : `${name}: uploading ${percent}%`;
  } };
  const fail = (error: unknown) => { const text = error instanceof Error ? error.message : 'The image could not be attached.'; if (target.isConnected) { const message = target.querySelector('[data-appearance-message]')!; message.textContent = text; message.setAttribute('role', 'alert'); target.querySelector<HTMLProgressElement>('progress')!.hidden = true; } options.status(text); };
  target.ondragenter = target.ondragover = event => { if (!appearanceDrag(event)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer!.dropEffect = options.enabled() ? 'copy' : 'none'; target.classList.toggle('appearance-drop-target', options.enabled()); };
  target.ondragleave = event => { if (!target.contains(event.relatedTarget as Node)) target.classList.remove('appearance-drop-target'); };
  target.ondrop = event => { if (!appearanceDrag(event)) return; event.preventDefault(); event.stopPropagation(); target.classList.remove('appearance-drop-target'); if (options.enabled()) void attachAppearanceDrop(options, event.dataTransfer!).catch(fail); };
  for (const image of target.querySelectorAll<HTMLImageElement>('[data-appearance-image]')) void appearanceImage(options.workspace, image.dataset.appearanceImage!).then(src => { if (image.isConnected) image.src = src; }, fail);
  const update = (edit: (value: AppearanceComponent) => void) => {
    const value = componentOf(options.item()); if (!value || !options.enabled()) return;
    edit(value); options.changed('Appearance reference updated');
  };
  target.querySelector<HTMLTextAreaElement>('[data-appearance-description]')!.onchange = event => update(value => { value.description = (event.target as HTMLTextAreaElement).value; });
  for (const button of target.querySelectorAll<HTMLButtonElement>('[data-appearance-primary]')) button.onclick = () => update(value => { const id = button.dataset.appearancePrimary!; value.imageIds = [id, ...value.imageIds.filter(entry => entry !== id)]; });
  for (const button of target.querySelectorAll<HTMLButtonElement>('[data-appearance-remove]')) button.onclick = () => update(value => { value.imageIds = value.imageIds.filter(id => id !== button.dataset.appearanceRemove); });
  const input = target.querySelector<HTMLInputElement>('[data-appearance-file]')!;
  target.querySelector<HTMLButtonElement>('[data-appearance-upload]')!.onclick = () => input.click();
  input.onchange = async () => {
    const files = [...input.files ?? []]; input.value = '';
    if (!files.length) return;
    const message = target.querySelector('[data-appearance-message]')!, progress = target.querySelector<HTMLProgressElement>('progress')!;
    message.textContent = 'Preparing images…'; message.setAttribute('role', 'status'); progress.hidden = false; progress.removeAttribute('value');
    const buttons = [...target.querySelectorAll<HTMLButtonElement>('button')]; buttons.forEach(button => { button.disabled = true; });
    try { await attachAppearanceFiles(options, files); } catch (error) { fail(error); }
    finally { progress.hidden = true; buttons.forEach(button => { button.disabled = !options.enabled(); }); }
  };
}

export function bindAppearanceDrop(viewport: HTMLElement, target: (x: number, y: number) => AppearanceEditor | null, status: (text: string) => void): void {
  const label = document.createElement('div'); label.className = 'appearance-drop-label'; label.hidden = true; viewport.append(label);
  const showTarget = (event: DragEvent) => {
    if (!appearanceDrag(event)) return;
    event.preventDefault(); const options = target(event.clientX, event.clientY), item = options?.item();
    event.dataTransfer!.dropEffect = options?.enabled() && item ? 'copy' : 'none';
    label.hidden = false; label.textContent = item ? `Appearance → ${item.name}` : 'Drop an image onto an object';
    const bounds = viewport.getBoundingClientRect(); label.style.left = `${Math.min(bounds.width - 240, Math.max(8, event.clientX - bounds.left + 16))}px`; label.style.top = `${Math.max(8, event.clientY - bounds.top - 38)}px`;
  };
  viewport.addEventListener('dragenter', showTarget);
  viewport.addEventListener('dragover', showTarget);
  viewport.addEventListener('dragleave', event => { if (!viewport.contains(event.relatedTarget as Node)) label.hidden = true; });
  viewport.addEventListener('drop', event => {
    if (!appearanceDrag(event)) return;
    event.preventDefault(); label.hidden = true; const options = target(event.clientX, event.clientY);
    if (!options || !options.enabled()) { status('Drop reference images directly onto an editable object.'); return; }
    void attachAppearanceDrop(options, event.dataTransfer!).catch(error => status(error.message));
  });
  document.addEventListener('dragend', () => { label.hidden = true; document.querySelectorAll('.appearance-drop-target').forEach(node => node.classList.remove('appearance-drop-target')); });
}
