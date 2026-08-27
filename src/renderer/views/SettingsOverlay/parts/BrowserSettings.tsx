import { startTransition } from "react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Select, ToggleSwitch } from "@/renderer/components/common";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import type { BrowserLinkPresentationMode } from "@/shared/settings";
import { BrowserCookieImportSettings } from "./BrowserCookieImportSettings";
import { SettingRow, SettingsPage } from "./SettingsForm";
import { useLocalizedOptions } from "./settingsOptions";

const linkPresentationModeOptions = [
  { id: "panel", label: msg`Right panel` },
  { id: "overlay", label: msg`Fullscreen overlay` },
] as const;

export function BrowserSettings() {
  const { t } = useLingui();
  const allowEval = useSharedSettings((s) => s.browser.allowEval);
  const allowDataAccess = useSharedSettings((s) => s.browser.allowDataAccess);
  const linkPresentationMode = useSharedSettings((s) => s.browser.linkPresentationMode);
  const setBrowserSetting = useSharedSettings((s) => s.setBrowserSetting);

  const linkPresentationModeOpts = useLocalizedOptions(linkPresentationModeOptions);

  return (
    <SettingsPage title={t`Browser`}>
      <SettingRow
        anchorId="browser.linkPresentationMode"
        title={t`Show opened links in`}
        description={t`When links open in a Y Space browser tab, choose where the browser is revealed.`}
      >
        <Select
          aria-label={t`Show opened links in`}
          className="w-[180px] shrink-0"
          options={linkPresentationModeOpts}
          value={linkPresentationMode}
          onChange={(value) => {
            startTransition(() => {
              setBrowserSetting("linkPresentationMode", value as BrowserLinkPresentationMode);
            });
          }}
        />
      </SettingRow>
      <SettingRow
        anchorId="browser.allowEval"
        title={t`Allow eval`}
        description={
          <Trans>
            Lets agents call <code>eval</code> to run arbitrary JavaScript inside the embedded page.
            Off by default — turn on only when you trust the loaded sites and the agent.
          </Trans>
        }
      >
        <ToggleSwitch
          aria-label={t`Allow eval`}
          isSelected={allowEval}
          onChange={(selected) => {
            startTransition(() => {
              setBrowserSetting("allowEval", selected);
            });
          }}
        />
      </SettingRow>
      <SettingRow
        anchorId="browser.allowDataAccess"
        title={t`Allow agents to read/write cookies and storage`}
        description={
          <Trans>
            Enables <code>cookies</code> and <code>storage</code>. Cookies can contain session
            tokens and storage often holds auth state — only enable when you trust both the agent
            and the sites it visits.
          </Trans>
        }
      >
        <ToggleSwitch
          aria-label={t`Allow agents to read/write cookies and storage`}
          isSelected={allowDataAccess}
          onChange={(selected) => {
            startTransition(() => {
              setBrowserSetting("allowDataAccess", selected);
            });
          }}
        />
      </SettingRow>
      <BrowserCookieImportSettings />
    </SettingsPage>
  );
}
