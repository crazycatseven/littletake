export interface XRAssetState {
  items: { id: string; name: string }[];
  canPlace: boolean;
  canDelete: boolean;
  selectionName?: string;
}

export const XR_ASSETS = 15, XR_ASSET_PREVIOUS = 16, XR_ASSET_PLACE = 17, XR_ASSET_NEXT = 18, XR_ASSET_DELETE = 19;
export const XR_ASSET_ACTIONS = [XR_ASSET_PREVIOUS, XR_ASSET_PLACE, XR_ASSET_NEXT, XR_ASSET_DELETE];
