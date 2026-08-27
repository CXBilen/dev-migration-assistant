import { useNavigate } from 'react-router'
import { getApi } from '../api'
import { WizardPage } from '../components/wizard-page'
import { KeyValueList } from '../components/ui/key-value'
import { Panel } from '../components/ui/panel'
import { PathText } from '../components/ui/path-text'
import { Switch } from '../components/ui/switch'
import { useAsyncValue } from '../hooks/use-async'
import { useHomeDir } from '../hooks/use-home-dir'
import { useShowEphemeral } from '../hooks/use-prefs'
import { ROUTES } from '../lib/routes'

export function SettingsScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const { homeDir } = useHomeDir()
  const [showEphemeral, setShowEphemeral] = useShowEphemeral()
  const suggestion = useAsyncValue(() => getApi().system.suggestBackupName())

  return (
    <WizardPage
      title="Settings"
      description="There is deliberately little to configure."
      backTo={() => void navigate(ROUTES.home)}
      backLabel="Home"
      testId="screen-settings"
      narrow
    >
      <Panel title="Appearance">
        <KeyValueList
          items={[
            {
              key: 'Theme',
              value: 'Follows the system appearance (light or dark). There is no separate setting.',
            },
          ]}
        />
      </Panel>
      <Panel title="Scan results">
        <label htmlFor="settings-show-ephemeral" className="flex cursor-pointer items-start gap-3">
          <Switch
            id="settings-show-ephemeral"
            checked={showEphemeral}
            onCheckedChange={setShowEphemeral}
            className="mt-0.5"
            data-testid="settings-show-ephemeral"
          />
          <span className="flex flex-col">
            <span className="text-[13px]">Show ephemeral state in scan results</span>
            <span className="text-[12px] text-fg-muted">
              Locks, caches and process registries are never backed up. Turn this on to see them
              listed for transparency.
            </span>
          </span>
        </label>
      </Panel>
      <Panel title="Backups">
        <KeyValueList
          items={[
            {
              key: 'Default folder',
              value: suggestion.data ? (
                <PathText
                  path={suggestion.data.defaultDirectory}
                  homeDir={homeDir}
                  className="text-fg"
                />
              ) : suggestion.loading ? (
                'Loading…'
              ) : (
                'Unknown'
              ),
              testId: 'settings-default-folder',
            },
            {
              key: 'File name',
              value: suggestion.data ? `${suggestion.data.name}.devbackup` : '—',
            },
            {
              key: 'Encryption',
              value: 'Always on. Argon2id + AES-256-GCM; the password is never stored.',
            },
            { key: 'Telemetry', value: 'None. No network access for user data.' },
          ]}
        />
      </Panel>
    </WizardPage>
  )
}
