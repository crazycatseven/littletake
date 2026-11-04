import {
  ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight,
  Box, Boxes, Check, ChevronDown, ChevronRight, ChevronUp, Circle, CircleDot,
  CircleHelp, Clock, Clapperboard, CodeXml, Cone, Copy, Cylinder, Diamond,
  Download, Ellipsis, Eye, EyeOff, FileText, Focus, Folder, FolderOpen, GripHorizontal, GripVertical,
  Group, Image, Keyboard, LayoutGrid, Link2, ListTree, LoaderCircle, LogOut,
  Maximize, Menu, Minus, Move3d, Navigation, Package, PanelBottom, Pause, Pencil,
  PersonStanding, Play, Plus, RectangleHorizontal, Redo2, RefreshCw, Rotate3d,
  RotateCcw, Save, Scaling, Search, Send, Settings2, SkipBack, SkipForward, Sparkles,
  Spline, Square, Timer, Trash2, Undo2, Upload, Video, WandSparkles, X,
  type IconNode, type SVGProps,
} from 'lucide';

const icons = {
  move: Move3d, rotate: Rotate3d, scale: Scaling,
  cube: Box, sphere: Circle, cylinder: Cylinder, cone: Cone,
  plane: RectangleHorizontal, human: PersonStanding, asset: Package,
  camera: Video, play: Play, pause: Pause, stop: Square, record: Circle,
  rewind: SkipBack, forward: SkipForward, duplicate: Copy, trash: Trash2,
  undo: Undo2, redo: Redo2, folder: Folder, 'folder-open': FolderOpen,
  save: Save, download: Download, upload: Upload, focus: Focus, plus: Plus,
  minus: Minus, key: Diamond, eye: Eye, hidden: EyeOff, help: CircleHelp,
  more: Ellipsis, menu: Menu, settings: Settings2, expand: Maximize, timeline: PanelBottom,
  close: X, check: Check, refresh: RefreshCw, retry: RotateCcw,
  'chevron-down': ChevronDown, 'chevron-up': ChevronUp, 'chevron-right': ChevronRight,
  'arrow-left': ArrowLeft, 'arrow-right': ArrowRight, 'arrow-up': ArrowUp,
  'arrow-down': ArrowDown, external: ArrowUpRight, ground: ArrowDownToLine,
  grip: GripVertical, 'grip-horizontal': GripHorizontal, sparkles: Sparkles, grid: LayoutGrid, code: CodeXml,
  link: Link2, path: Spline, group: Group, layers: Boxes, tree: ListTree,
  keyboard: Keyboard, send: Send, image: Image, file: FileText, film: Clapperboard,
  loader: LoaderCircle, exit: LogOut, navigate: Navigation, target: CircleDot,
  clock: Clock, timer: Timer, wand: WandSparkles, search: Search, rename: Pencil,
} satisfies Record<string, IconNode>;
export type IconName = keyof typeof icons;
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const attributes = (attrs: SVGProps) => Object.entries(attrs).filter(([,value]) => value !== undefined).map(([key,value]) => ` ${key}="${escape(value!)}"`).join('');

/** The same Lucide SVG source works in HTML, generated SVG and XR textures. */
export function icon(name: IconName, attrs: SVGProps = {}): string {
  const node = icons[name];
  return `<svg${attributes({xmlns:'http://www.w3.org/2000/svg',width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.75,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false',class:'ui-icon','data-icon':name,...attrs})}>${node.map(([tag,props]) => `<${tag}${attributes(props)}/>`).join('')}</svg>`;
}
