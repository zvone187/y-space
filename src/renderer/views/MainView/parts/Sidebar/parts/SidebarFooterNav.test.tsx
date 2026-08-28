import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { useChangelogStore } from "@/renderer/state/changelogStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { useUpdateStore } from "@/renderer/state/updateStore";
import { useWorkspaceStore } from "@/renderer/state/workspaceStore";
import { SidebarContext } from "@/renderer/views/MainView/parts/AppShell/AppShell";
import type { Workspace } from "@/shared/contracts";

const bridge = vi.hoisted(() => ({
  appVersion: "1.6.6",
  installUpdate: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/renderer/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/renderer/bridge")>();
  return { ...actual, readBridge: () => bridge };
});

import { SidebarFooterNav } from "./SidebarFooterNav";

const primaryWorkspace: Workspace = {
  id: "workspace-primary",
  name: "Personal",
  createdAt: "2026-01-01T00:00:00.000Z",
  icon: "palette",
};

const teamWorkspace: Workspace = {
  id: "workspace-team",
  name: "Team",
  createdAt: "2026-01-02T00:00:00.000Z",
  icon: "briefcase",
};

function openMore(): void {
  fireEvent.click(screen.getByRole("button", { name: "More" }));
}

describe("SidebarFooterNav", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.installUpdate.mockResolvedValue(undefined);
    localStorage.clear();
    usePanelStore.setState({
      settingsOpen: false,
      settingsSection: "general",
      usagePanelOpen: false,
    });
    useSharedSettings.setState({
      workspaces: [primaryWorkspace],
      sidebarHiddenShortcuts: ["githubActions"],
      sidebarShortcutOrder: ["pullRequests", "githubActions", "schedules"],
    });
    useWorkspaceStore.setState({ activeWorkspaceId: primaryWorkspace.id });
    useUpdateStore.setState({
      phase: "idle",
      version: null,
      downloadPercent: 0,
      errorMessage: null,
      downloadTransferred: null,
      downloadTotal: null,
      downloadBytesPerSecond: null,
    });
    useChangelogStore.setState({
      releases: [],
      lastSeenVersion: bridge.appVersion,
      acknowledgedVersion: bridge.appVersion,
      whatsNewOpen: false,
      whatsNewHidden: true,
    });
  });

  it("shows only the three-dot destination control", () => {
    render(<SidebarFooterNav remoteAccessStatus="off" />);

    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
        .filter(Boolean),
    ).toEqual(["More"]);
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "What's New" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch workspace" })).not.toBeInTheDocument();
  });

  it("moves sidebar visibility into the More menu", async () => {
    const collapse = vi.fn<() => void>();
    render(
      <SidebarContext.Provider
        value={{
          isCollapsed: false,
          isOverlay: false,
          closingOverlay: false,
          collapse,
          expand: vi.fn<() => void>(),
        }}
      >
        <SidebarFooterNav remoteAccessStatus="off" />
      </SidebarContext.Provider>,
    );
    openMore();

    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide sidebar" }));
    expect(collapse).toHaveBeenCalledOnce();
  });

  it("keeps every destination available in the saved shortcut order", async () => {
    render(<SidebarFooterNav remoteAccessStatus="off" />);
    openMore();

    expect(await screen.findByRole("menuitem", { name: "Usage" })).toBeInTheDocument();
    const pullRequests = screen.getByRole("menuitemcheckbox", { name: "Pull requests" });
    const schedules = screen.getByRole("menuitemcheckbox", { name: "Schedules" });
    expect(
      pullRequests.compareDocumentPosition(schedules) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "GitHub Actions" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "What's New" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: /Remote Access/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Hide sidebar" })).toBeInTheDocument();
  });

  it("opens settings from the More menu", async () => {
    render(<SidebarFooterNav remoteAccessStatus="off" />);
    openMore();

    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Settings" }));

    expect(usePanelStore.getState().settingsOpen).toBe(true);
  });

  it("marks the trigger and Remote Access item active for that settings section", async () => {
    usePanelStore.setState({ settingsOpen: true, settingsSection: "remoteAccess" });
    render(<SidebarFooterNav remoteAccessStatus="online" />);

    const trigger = screen.getByRole("button", { name: "More" });
    expect(trigger.className).toContain("bg-[var(--row-active)]");
    openMore();
    expect(await screen.findByRole("menuitemcheckbox", { name: /Remote Access/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("keeps What's New accessible after its former sidebar entry was hidden", async () => {
    render(<SidebarFooterNav remoteAccessStatus="off" />);
    openMore();

    fireEvent.click(await screen.findByRole("menuitem", { name: "What's New" }));

    expect(useChangelogStore.getState().whatsNewOpen).toBe(true);
  });

  it("switches workspace from the nested menu without adding another footer button", async () => {
    useSharedSettings.setState({ workspaces: [primaryWorkspace, teamWorkspace] });
    render(<SidebarFooterNav remoteAccessStatus="off" />);
    openMore();

    const workspaceMenu = await screen.findByRole("menuitem", { name: /Workspace/ });
    fireEvent.keyDown(workspaceMenu, { key: "ArrowRight" });
    const team = await screen.findByRole("menuitemradio", { name: "Team" });
    fireEvent.click(team);

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(teamWorkspace.id);
    });
  });

  it("shows inert download progress and installs a completed update", async () => {
    useUpdateStore.setState({
      phase: "downloading",
      version: "1.7.0",
      downloadPercent: 42.4,
    });
    const { unmount } = render(<SidebarFooterNav remoteAccessStatus="off" />);
    openMore();

    const progress = await screen.findByRole("menuitem", { name: /Downloading update/ });
    expect(progress).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("42%")).toBeInTheDocument();

    unmount();
    useUpdateStore.setState({ phase: "downloaded", version: "1.7.0", downloadPercent: 100 });
    render(<SidebarFooterNav remoteAccessStatus="off" />);
    openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Install v1.7.0" }));

    expect(bridge.installUpdate).toHaveBeenCalledOnce();
  });
});
