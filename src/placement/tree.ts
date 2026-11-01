const TREE_DRAG = 'application/x-littletake-hierarchy';
interface TreeOptions {
  enabled(): boolean;
  selected(): string[];
  allowed(ids: string[], parentId: string | null): boolean;
  drop(ids: string[], parentId: string | null): void;
  error(message: string): void;
}
/** A drag belongs to one tree. Asset-library copying may share the same native drag. */
export function bindParentingTree(root: HTMLElement, options: TreeOptions): () => void {
  let ids: string[] = [], marked: HTMLElement | null = null;
  const clear = () => { marked?.classList.remove('hierarchy-drop-target'); marked=null; root.classList.remove('hierarchy-dragging'); };
  const target = (event: DragEvent) => (event.target as HTMLElement).closest<HTMLElement>('[data-tree-id]');
  const start = (event: DragEvent) => {
    const row=target(event); if (!row) return;
    if (!options.enabled() || row.draggable===false || !event.dataTransfer) { event.preventDefault(); return; }
    const selected=options.selected(), id=row.dataset.treeId!;
    ids=selected.includes(id)?selected:[id];
    event.dataTransfer.setData(TREE_DRAG,'parent');
    if(!event.dataTransfer.types.includes('text/plain'))event.dataTransfer.setData('text/plain',row.textContent??id);
    event.dataTransfer.effectAllowed='copyMove'; root.classList.add('hierarchy-dragging');
  };
  const over = (event: DragEvent) => {
    if (!ids.length || !options.enabled() || !event.dataTransfer?.types.includes(TREE_DRAG)) return;
    const row=target(event), parentId=row?.dataset.treeId??null;
    marked?.classList.remove('hierarchy-drop-target'); marked=null;
    if (!options.allowed(ids,parentId)) { event.dataTransfer.dropEffect='none'; return; }
    event.preventDefault(); event.dataTransfer.dropEffect='move';
    marked=row??root.querySelector<HTMLElement>('[data-tree-root]')??root; marked.classList.add('hierarchy-drop-target');
  };
  const drop = (event: DragEvent) => {
    if (!ids.length || !event.dataTransfer?.types.includes(TREE_DRAG)) return;
    event.preventDefault(); event.stopPropagation(); const moving=ids; ids=[]; const parentId=target(event)?.dataset.treeId??null; clear();
    if (!options.enabled() || !options.allowed(moving,parentId)) return;
    try { options.drop(moving,parentId); } catch (error) { options.error(error instanceof Error?error.message:'Could not change the parent.'); }
  };
  const end = () => { ids=[]; clear(); };
  const leave = (event: DragEvent) => { if (!root.contains(event.relatedTarget as Node)) { marked?.classList.remove('hierarchy-drop-target');marked=null; } };
  root.addEventListener('dragstart',start); root.addEventListener('dragover',over); root.addEventListener('drop',drop); root.addEventListener('dragend',end); root.addEventListener('dragleave',leave);
  return () => { end(); root.removeEventListener('dragstart',start); root.removeEventListener('dragover',over); root.removeEventListener('drop',drop); root.removeEventListener('dragend',end); root.removeEventListener('dragleave',leave); };
}
