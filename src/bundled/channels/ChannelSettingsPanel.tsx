import { usePanelTabHost } from "../../features/panels/PanelWorkspace";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { useReferenceDirectory } from "../../features/messages/ReferenceText";
import { channelIcon } from "../../features/channels/channel-icon";
import {
  GearIcon,
  CircleNotchIcon,
  CaretRightIcon,
  CopyIcon,
  PencilSimpleIcon,
} from "../../shared/design-system/icons/index";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import styles from "./Channels.module.css";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import {
  ChannelDetailsEditor,
  type ChannelDetailsAction,
} from "./ChannelDetailsEditor";
import { writeClipboardText } from "../../shared/clipboard";

export function ChannelSettingsPanel({
  channel,
  scope,
  close,
  children,
  setupTools,
  details,
  openMembers,
  session,
  canOpenLink,
  onOpenLink,
}: {
  channel: ChannelSummary | undefined;
  scope: string;
  close(): void;
  children: ReactNode;
  setupTools?: ReactNode;
  details?: ChannelDetailsCapability;
  openMembers?(trigger: HTMLButtonElement): void;
  /** Links the description like a message; without these it stays plain text. */
  session?: RelaySession | undefined;
  canOpenLink?(target: string): boolean;
  onOpenLink?(url: string): boolean;
}) {
  const tabbed = !!usePanelTabHost();
  const directory = useReferenceDirectory(session);
  const header = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (tabbed) return;
    header.current
      ?.querySelector<HTMLElement>('[role="tab"]')
      ?.focus({ preventScroll: true });
  }, [tabbed]);
  const ChannelIcon = channelIcon(channel);
  const renderPanel = (
    edit?: ChannelDetailsAction,
    editStatus?: ReactNode,
    loading = false,
  ) => (
    <Panel
      as="aside"
      aria-label="Channel settings"
      aria-busy={loading}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div ref={header} className={styles.settingsPanel}>
        {!tabbed && (
          <PanelHeader
            title={
              <Tabs
                variant="navigation"
                label="Panel tabs"
                value="settings"
                onValueChange={() => {}}
                items={[
                  {
                    value: "settings",
                    label: "Channel settings",
                    icon: <GearIcon size="1rem" />,
                    panelId,
                    onClose: close,
                  },
                ]}
              />
            }
          />
        )}
        <div
          id={tabbed ? undefined : panelId}
          {...(!tabbed
            ? { role: "tabpanel", "aria-labelledby": `${panelId}-tab` }
            : {})}
          className={styles.settingsContent}
        >
          {channel && (
            <>
              <div className={styles.settingsIdentity}>
                <span className={styles.settingsIcon}>
                  <ChannelIcon size={32} aria-hidden="true" />
                </span>
                <h3
                  className={`text-heading text-primary ${styles.settingsTitle}`}
                  aria-label={channel.name}
                >
                  {edit ? (
                    <button
                      type="button"
                      className={styles.settingsTitleAction}
                      aria-label="Edit channel name"
                      disabled={edit.pending}
                      aria-busy={edit.pending}
                      aria-description={channel.name}
                      aria-haspopup="dialog"
                      onClick={(event) => edit.open(event.currentTarget)}
                    >
                      <span>
                        {channel.name}
                        {"\u2060"}
                        <span
                          className={styles.settingsTitlePencil}
                          aria-hidden="true"
                        >
                          {edit.pending ? (
                            <CircleNotchIcon
                              size={16}
                              className="motion-safe:animate-spin"
                            />
                          ) : (
                            <PencilSimpleIcon size={16} />
                          )}
                        </span>
                      </span>
                    </button>
                  ) : (
                    channel.name
                  )}
                </h3>
              </div>
              <dl className={styles.settingsDetails}>
                {channel.channelType !== "solo" &&
                  channel.channelType !== "dm" && (
                    <SettingsDetail
                      label="Description"
                      value={
                        channel.description === undefined
                          ? "Not available"
                          : channel.description || "No description"
                      }
                      content={
                        channel.description &&
                        session &&
                        onOpenLink && (
                          <MessageMarkdown
                            row={{
                              id: "channel-description",
                              authorId: "",
                              createdAt: 0,
                              channelId: channel.id,
                              content: channel.description,
                              mentions: [],
                              participants: [],
                              attachments: [],
                              reactions: [],
                              replyCount: 0,
                            }}
                            directory={directory}
                            session={session}
                            scope={scope}
                            media={session.media}
                            onOpenLink={onOpenLink}
                            canOpenLink={canOpenLink}
                          />
                        )
                      }
                      valueClassName={styles.settingsDescription}
                      labelOnly
                      actionLabel="Edit"
                      loading={edit?.pending}
                      onOpen={
                        edit
                          ? (trigger) => edit.open(trigger, "description")
                          : undefined
                      }
                    />
                  )}
                {channel.members && (
                  <SettingsDetail
                    label="Members"
                    value={String(channel.members.length)}
                    trailingIcon={
                      <CaretRightIcon size={16} aria-hidden="true" />
                    }
                    onOpen={openMembers}
                  />
                )}
                <ChannelIdDetail key={channel.id} id={channel.id} />
              </dl>
            </>
          )}
          {editStatus}
          {setupTools}
          <details className={styles.settingsDiagnostics}>
            <summary>Diagnostics</summary>
            <div className={styles.settingsTools}>{children}</div>
          </details>
        </div>
      </div>
    </Panel>
  );
  const editable =
    channel &&
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    !channel.readOnly &&
    !channel.cached &&
    !channel.archived;
  return editable && details?.available ? (
    <ChannelDetailsEditor
      channel={channel}
      capability={details}
      scope={scope}
      renderSurface={renderPanel}
    />
  ) : (
    renderPanel(
      undefined,
      editable ? <p>Editing is unavailable on this connection.</p> : undefined,
    )
  );
}

/** A native button's hit area covers the row without nesting controls or losing list semantics. */
function SettingsDetail({
  label,
  value,
  content,
  valueClassName,
  feedback,
  actionLabel,
  actionIcon = <PencilSimpleIcon size={14} />,
  trailingIcon,
  onOpen,
  hasPopup = "dialog",
  disabled = false,
  loading = false,
  labelOnly = false,
  renderAction = (action) => action,
}: {
  label: string;
  /** Plain value, also the action's description. */
  value: string;
  /** Rendered in place of `value` when present. */
  content?: ReactNode;
  valueClassName?: string | undefined;
  feedback?: ReactNode;
  actionLabel?: string | undefined;
  actionIcon?: ReactNode;
  trailingIcon?: ReactNode;
  hasPopup?: "dialog" | false;
  disabled?: boolean;
  loading?: boolean | undefined;
  /** Only the label opens the action, so the value's own links stay usable. */
  labelOnly?: boolean;
  renderAction?(action: ReactElement<ComponentProps<"button">>): ReactNode;
  onOpen?: ((trigger: HTMLButtonElement) => void) | undefined;
}) {
  return (
    <div>
      <dt>
        {onOpen
          ? renderAction(
              <button
                type="button"
                className={
                  labelOnly
                    ? `${styles.settingsDetailAction} ${styles.settingsLabelAction}`
                    : styles.settingsDetailAction
                }
                aria-label={
                  actionLabel
                    ? `${actionLabel} ${label.toLowerCase()}`
                    : `View ${label.toLowerCase()}`
                }
                aria-description={value}
                aria-haspopup={hasPopup}
                disabled={loading}
                aria-busy={loading || undefined}
                aria-disabled={disabled || undefined}
                onClick={(event) => {
                  if (!disabled && !loading) onOpen(event.currentTarget);
                }}
              >
                <span className={styles.settingsDetailLabel}>
                  <span>{label}</span>
                  {!trailingIcon && (
                    <span
                      className={styles.settingsDetailIcon}
                      aria-hidden="true"
                    >
                      {loading ? (
                        <CircleNotchIcon
                          size={14}
                          className="motion-safe:animate-spin"
                        />
                      ) : (
                        actionIcon
                      )}
                    </span>
                  )}
                </span>
                {trailingIcon}
              </button>,
            )
          : label}
      </dt>
      <dd className={valueClassName}>
        {content || value}
        {feedback}
      </dd>
    </div>
  );
}

function ChannelIdDetail({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">(
    "idle",
  );
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  async function copy() {
    setFeedbackOpen(false);
    setState("copying");
    try {
      await writeClipboardText(id);
      setState("copied");
      setFeedbackOpen(true);
    } catch {
      setState("failed");
    }
  }
  return (
    <SettingsDetail
      label="Channel ID"
      value={id}
      valueClassName={styles.settingsId}
      feedback={
        state === "failed" && (
          <p role="alert" className="text-danger">
            Couldn’t copy channel ID. Try again.
          </p>
        )
      }
      actionLabel="Copy"
      actionIcon={<CopyIcon size={14} />}
      hasPopup={false}
      disabled={state === "copying"}
      onOpen={() => void copy()}
      renderAction={(action) => (
        <Tooltip
          open={state === "copied" && feedbackOpen}
          closeOnClick={false}
          onOpenChange={(open) => {
            if (!open) setFeedbackOpen(false);
          }}
          disableHoverablePopup
          content={<span role="status">Channel ID copied</span>}
        >
          {action}
        </Tooltip>
      )}
    />
  );
}
