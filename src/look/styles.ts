export const storyboardStyles = {
  scene: { label: 'Match scene', direction: 'Follow the scene lighting and the bound appearance references.' },
  cinematic: { label: 'Cinematic', direction: 'Use a live-action film look with natural materials and cinematic lighting.' },
  painted: { label: 'Hand-painted', direction: 'Use layered brushwork and a hand-painted color palette.' },
  pencil: { label: 'Pencil sketch', direction: 'Use a monochrome graphite storyboard with expressive linework and tonal shading.' },
  anime: { label: 'Anime', direction: 'Use clean anime linework, cel shading and expressive silhouettes.' },
} as const;
export type StoryboardStyle = keyof typeof storyboardStyles;
export const storyboardStyleIds = Object.keys(storyboardStyles) as StoryboardStyle[];
