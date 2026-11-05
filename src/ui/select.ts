// Custom popover dropdown enhancer for native <select> elements.
// Intercepts pointer/keyboard opening so the OS native popup never appears,
// while preserving select.value, select.innerHTML, and native change/input events.

let activeSelect: HTMLSelectElement | null = null;
let menuEl: HTMLDivElement | null = null;
let focusedIndex = -1;

function closeSelectMenu(restoreFocus = false) {
  if (!activeSelect && !menuEl) return;
  const select = activeSelect;
  activeSelect = null;
  focusedIndex = -1;
  if (select) {
    delete select.dataset.selectOpen;
    if (restoreFocus) select.focus({ preventScroll: true });
  }
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}

function commitOption(select: HTMLSelectElement, index: number) {
  const options = Array.from(select.options);
  const option = options[index];
  if (!option || option.disabled) return;
  const changed = select.selectedIndex !== index || select.value !== option.value;
  select.selectedIndex = index;
  select.value = option.value;
  closeSelectMenu(true);
  if (changed) {
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function updateHighlightedOption() {
  if (!menuEl) return;
  const items = menuEl.querySelectorAll<HTMLButtonElement>('[data-select-index]');
  items.forEach(item => {
    const idx = Number(item.dataset.selectIndex);
    const active = idx === focusedIndex;
    item.classList.toggle('is-focused', active);
    if (active) item.scrollIntoView({ block: 'nearest' });
  });
}

function positionMenu(select: HTMLSelectElement, menu: HTMLDivElement, host: HTMLElement) {
  const rect = select.getBoundingClientRect();
  const hostRect = host === document.body
    ? { left: 0, top: 0 }
    : host.getBoundingClientRect();
  const scrollLeft = host === document.body ? 0 : host.scrollLeft;
  const scrollTop = host === document.body ? 0 : host.scrollTop;

  const minWidth = Math.max(rect.width, 148);
  menu.style.minWidth = `${Math.round(minWidth)}px`;
  menu.style.maxWidth = `${Math.max(Math.round(rect.width), 280)}px`;

  // Measure after inserting
  const menuRect = menu.getBoundingClientRect();
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  let left = rect.left;
  if (left + menuRect.width > viewportW - 10) {
    left = Math.max(10, rect.right - menuRect.width);
  }

  const spaceBelow = viewportH - rect.bottom - 10;
  const spaceAbove = rect.top - 10;
  const openUpward = spaceBelow < Math.min(menuRect.height, 220) && spaceAbove > spaceBelow;

  if (openUpward) {
    const maxH = Math.min(280, Math.max(120, spaceAbove - 6));
    menu.style.maxHeight = `${Math.round(maxH)}px`;
    const actualH = Math.min(menuRect.height, maxH);
    const top = rect.top - actualH - 5;
    menu.style.left = `${Math.round(left - hostRect.left + scrollLeft)}px`;
    menu.style.top = `${Math.round(top - hostRect.top + scrollTop)}px`;
    menu.dataset.placement = 'top';
  } else {
    const maxH = Math.min(280, Math.max(120, spaceBelow - 6));
    menu.style.maxHeight = `${Math.round(maxH)}px`;
    const top = rect.bottom + 5;
    menu.style.left = `${Math.round(left - hostRect.left + scrollLeft)}px`;
    menu.style.top = `${Math.round(top - hostRect.top + scrollTop)}px`;
    menu.dataset.placement = 'bottom';
  }
}

function openSelectMenu(select: HTMLSelectElement) {
  if (select.disabled || !select.options.length) return;
  if (activeSelect === select) {
    closeSelectMenu();
    return;
  }
  closeSelectMenu();

  activeSelect = select;
  select.dataset.selectOpen = 'true';

  const menu = document.createElement('div');
  menu.className = 'studio-select-menu';
  menu.setAttribute('role', 'listbox');
  const label = select.getAttribute('aria-label');
  if (label) menu.setAttribute('aria-label', label);

  // Use dark optical surface when opened inside dark camera-body chrome
  if (select.closest('#shotPanel, .app-header, .projects-heading')) {
    menu.dataset.theme = 'dark';
  }

  const options = Array.from(select.options);
  focusedIndex = Math.max(0, select.selectedIndex);

  options.forEach((option, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'studio-select-option';
    item.dataset.selectIndex = String(index);
    item.setAttribute('role', 'option');
    const isSelected = index === select.selectedIndex;
    item.setAttribute('aria-selected', String(isSelected));
    if (isSelected) item.classList.add('is-selected');
    if (index === focusedIndex) item.classList.add('is-focused');
    if (option.disabled) item.disabled = true;

    const text = document.createElement('span');
    text.className = 'studio-select-option-label';
    text.textContent = option.textContent ?? option.label;

    const check = document.createElement('span');
    check.className = 'studio-select-option-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = isSelected
      ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>'
      : '';

    item.append(text, check);
    item.addEventListener('pointerenter', () => {
      if (option.disabled) return;
      focusedIndex = index;
      updateHighlightedOption();
    });
    item.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
    });
    item.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      commitOption(select, index);
    });
    menu.appendChild(item);
  });

  // Mount inside open top-layer dialog or popover if present so it sits above ::backdrop
  const topLayerHost = select.closest<HTMLElement>('dialog[open], [popover]:popover-open') ?? document.body;
  topLayerHost.appendChild(menu);
  menuEl = menu;

  positionMenu(select, menu, topLayerHost);
  updateHighlightedOption();
}

function moveFocus(delta: number) {
  if (!activeSelect) return;
  const options = Array.from(activeSelect.options);
  if (!options.length) return;
  let next = focusedIndex;
  for (let i = 0; i < options.length; i++) {
    next = (next + delta + options.length) % options.length;
    if (!options[next].disabled) {
      focusedIndex = next;
      updateHighlightedOption();
      return;
    }
  }
}

export function installCustomSelects() {
  document.addEventListener('mousedown', event => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (menuEl && menuEl.contains(target)) return;
    const select = target.closest<HTMLSelectElement>('select');
    if (select) {
      if (event.button !== 0 || select.disabled) return;
      event.preventDefault();
      select.focus({ preventScroll: true });
      openSelectMenu(select);
      return;
    }
    if (activeSelect) closeSelectMenu();
  }, true);

  // Also suppress native popup on click/space activation
  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const select = target?.closest<HTMLSelectElement>('select');
    if (select && !select.disabled) {
      event.preventDefault();
    }
  }, true);

  document.addEventListener('keydown', event => {
    if (activeSelect) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeSelectMenu(true);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        moveFocus(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        moveFocus(-1);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        event.stopPropagation();
        focusedIndex = -1;
        moveFocus(1);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        focusedIndex = 0;
        moveFocus(-1);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        if (focusedIndex >= 0) commitOption(activeSelect, focusedIndex);
        else closeSelectMenu(true);
        return;
      }
      if (event.key === 'Tab') {
        closeSelectMenu(false);
        return;
      }
    }

    const target = event.target;
    if (target instanceof HTMLSelectElement && !target.disabled) {
      if (event.key === ' ' || event.key === 'Enter' || (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))) {
        event.preventDefault();
        openSelectMenu(target);
      }
    }
  }, true);

  window.addEventListener('resize', () => closeSelectMenu(), { passive: true });
  window.addEventListener('blur', () => closeSelectMenu(), { passive: true });
  document.addEventListener('scroll', event => {
    if (menuEl && event.target instanceof Node && menuEl.contains(event.target)) return;
    if (activeSelect) closeSelectMenu();
  }, { capture: true, passive: true });
}
