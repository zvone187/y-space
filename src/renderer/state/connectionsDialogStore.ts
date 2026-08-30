import { create } from "zustand";

export type ConnectionsDialogSource = "composer" | "settings";

interface ConnectionsDialogStore {
  isOpen: boolean;
  source: ConnectionsDialogSource | null;
  revision: number;
  openDialog: (source: ConnectionsDialogSource) => void;
  closeDialog: () => void;
  bumpRevision: () => void;
}

/**
 * One global entry point for Pipedream connections. The dialog owns all
 * transient OAuth and catalog state; the revision lets compact Settings chrome
 * refresh its renderer-safe account summary without duplicating that logic.
 */
export const useConnectionsDialogStore = create<ConnectionsDialogStore>()((set) => ({
  isOpen: false,
  source: null,
  revision: 0,
  openDialog: (source) => set({ isOpen: true, source }),
  closeDialog: () => set({ isOpen: false, source: null }),
  bumpRevision: () => set((state) => ({ revision: state.revision + 1 })),
}));
