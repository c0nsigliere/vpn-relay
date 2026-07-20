import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "../components/Layout";
import { useTelegram } from "../hooks/useTelegram";
import {
  downloadBackup,
  fetchAlertSettings,
  fetchBackupConfig,
  fetchDbInfo,
  patchAlertSetting,
  patchBackupConfig,
} from "../api/client";
import { formatBytes } from "../utils/format";
import type {
  AlertSetting,
  BackupConfig,
  DbInfoResponse,
  UpdateBackupConfigRequest,
} from "@vpn-relay/shared";
import { BACKUP_INTERVAL_PRESETS } from "@vpn-relay/shared";

// ── Alert metadata ────────────────────────────────────────────────────────────

interface FieldDef {
  key: "threshold" | "threshold2" | "cooldown_min";
  label: string;
  unit: string;
  min?: number;
  step?: number;
}

interface AlertMeta {
  name: string;
  description: string;
  group: "critical" | "warning" | "info";
  fields: FieldDef[];
}

const ALERT_META: Record<string, AlertMeta> = {
  cascade_down: {
    name: "Cascade Down",
    description: "Server A unreachable — 100% packet loss sustained",
    group: "critical",
    fields: [
      { key: "threshold", label: "Loss %", unit: "%", min: 1 },
      { key: "threshold2", label: "Duration", unit: "min", min: 1 },
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 1 },
    ],
  },
  service_dead_xray: {
    name: "XRay Service Dead",
    description: "XRay service on Server B is not running",
    group: "critical",
    fields: [
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 1 },
    ],
  },
  service_dead_singbox: {
    name: "sing-box Service Dead",
    description: "sing-box (Hysteria 2) service on Server B is not running",
    group: "critical",
    fields: [
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 1 },
    ],
  },
  service_dead_wg: {
    name: "WireGuard Service Dead",
    description: "WireGuard service on Server A is not running",
    group: "critical",
    fields: [
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 1 },
    ],
  },
  disk_full: {
    name: "Disk Full",
    description: "Disk usage exceeds threshold on either server",
    group: "critical",
    fields: [
      { key: "threshold", label: "Usage %", unit: "%", min: 1, step: 5 },
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 1 },
    ],
  },
  cascade_degradation: {
    name: "Cascade Degradation",
    description: "Server A has partial packet loss (not full outage)",
    group: "warning",
    fields: [
      { key: "threshold", label: "Loss %", unit: "%", min: 1 },
      { key: "threshold2", label: "Duration", unit: "min", min: 1 },
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 1 },
    ],
  },
  network_saturation: {
    name: "Network Saturation",
    description: "Throughput exceeds % of channel capacity for sustained duration",
    group: "warning",
    fields: [
      { key: "threshold", label: "Saturation %", unit: "%", min: 1, step: 5 },
      { key: "threshold2", label: "Duration", unit: "min", min: 1 },
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 1 },
    ],
  },
  cpu_overload: {
    name: "CPU Overload",
    description: "CPU usage exceeds threshold for sustained duration",
    group: "warning",
    fields: [
      { key: "threshold", label: "CPU %", unit: "%", min: 1, step: 5 },
      { key: "threshold2", label: "Duration", unit: "min", min: 1 },
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 1 },
    ],
  },
  cert_expiry: {
    name: "TLS Cert Expiry",
    description: "TMA domain certificate expires within threshold days",
    group: "warning",
    fields: [
      { key: "threshold", label: "Days left", unit: "days", min: 1 },
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 1 },
    ],
  },
  reboot_detected: {
    name: "Reboot Detected",
    description: "Server uptime is below 10 minutes (recently rebooted)",
    group: "warning",
    fields: [
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 1 },
    ],
  },
  reboot_required: {
    name: "Reboot Required",
    description: "Server has pending reboot (/var/run/reboot-required exists)",
    group: "warning",
    fields: [
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 1 },
    ],
  },
  abnormal_traffic: {
    name: "Abnormal Traffic",
    description: "Client exceeds traffic threshold per hour — auto-suspended",
    group: "info",
    fields: [
      { key: "threshold", label: "Limit GB/hr", unit: "GB/hr", min: 1 },
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 1 },
    ],
  },
  quota_warning: {
    name: "Quota Warning",
    description: "Client's monthly quota usage reaches warning threshold",
    group: "info",
    fields: [
      { key: "threshold", label: "Usage %", unit: "%", min: 1, step: 5 },
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 720 },
    ],
  },
  updates_pending: {
    name: "Updates Pending",
    description: "Enriched package update alerts with changelogs and AI summaries",
    group: "info",
    fields: [
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 60 },
    ],
  },
  backup_failed: {
    name: "Backup Failed",
    description: "A scheduled backup failed, or was kept locally because delivery to Telegram failed",
    group: "warning",
    fields: [
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 30 },
    ],
  },
  backup_stale: {
    name: "Backups Stale",
    description:
      "No backup has completed within the schedule plus this grace period. Grace is added on top of the configured interval, so it scales when you change daily ↔ weekly",
    group: "warning",
    fields: [
      { key: "threshold", label: "Grace", unit: "h", min: 1 },
      { key: "cooldown_min", label: "Cooldown", unit: "min", min: 60 },
    ],
  },
};

/** "Last backup: 2026-07-20 03:00 UTC ✅ (1.9 MB, sent to chat)" */
function lastBackupLabel(last: DbInfoResponse["lastBackup"]): string {
  if (!last || !last.finished_at) return "Last backup: never";
  const icon = last.status === "success" ? "✅" : last.status === "degraded" ? "⚠️" : "❌";
  const size = last.bundle_bytes ? formatBytes(last.bundle_bytes) : null;
  const where = last.telegram_ok === 1 ? "sent to chat" : "local only";
  return `Last backup: ${last.finished_at} UTC ${icon}${size ? ` (${size}, ${where})` : ""}`;
}

/** Presets plus a "Custom" escape hatch that reveals a day-count field. */
function BackupSchedule({
  config,
  onChange,
  saving,
}: {
  config: BackupConfig;
  onChange: (patch: UpdateBackupConfigRequest) => void;
  saving: boolean;
}) {
  const isPreset = BACKUP_INTERVAL_PRESETS.some((p) => p.days === config.intervalDays);
  const [custom, setCustom] = useState(!isPreset);
  const [customDays, setCustomDays] = useState(String(config.intervalDays));

  return (
    <div className="mt-3 pt-3 border-t border-tg-hint/20">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-tg">Schedule</span>
        <label className="flex items-center gap-2 text-xs text-tg-hint">
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={saving}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          Enabled
        </label>
      </div>

      <div className="flex flex-wrap gap-2 mb-2">
        {BACKUP_INTERVAL_PRESETS.map((preset) => {
          const active = !custom && config.intervalDays === preset.days;
          return (
            <button
              key={preset.days}
              disabled={saving || !config.enabled}
              onClick={() => {
                setCustom(false);
                onChange({ intervalDays: preset.days });
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 ${
                active ? "bg-tg-button text-tg-button" : "bg-tg-bg text-tg-hint"
              }`}
            >
              {preset.label}
            </button>
          );
        })}
        <button
          disabled={saving || !config.enabled}
          onClick={() => setCustom(true)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 ${
            custom ? "bg-tg-button text-tg-button" : "bg-tg-bg text-tg-hint"
          }`}
        >
          Custom
        </button>
      </div>

      {custom && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-tg-hint">Every</span>
          <input
            type="number"
            min={1}
            max={30}
            value={customDays}
            disabled={saving || !config.enabled}
            onChange={(e) => setCustomDays(e.target.value)}
            onBlur={() => {
              const n = parseInt(customDays, 10);
              if (Number.isFinite(n)) onChange({ intervalDays: n });
            }}
            className="w-16 px-2 py-1 rounded-lg bg-tg-bg text-tg text-xs text-right"
          />
          <span className="text-xs text-tg-hint">days (1–30)</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-xs text-tg-hint">At</span>
        <input
          type="number"
          min={0}
          max={23}
          value={config.hourUtc}
          disabled={saving || !config.enabled}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n)) onChange({ hourUtc: n });
          }}
          className="w-16 px-2 py-1 rounded-lg bg-tg-bg text-tg text-xs text-right"
        />
        <span className="text-xs text-tg-hint">:00 UTC</span>
      </div>

      {config.enabled && (
        <p className="mt-2 text-xs text-tg-hint">
          Next run: {config.nextRun.slice(0, 16).replace("T", " ")} UTC
          {config.intervalDays === 7 && " · weekly runs land on Mondays"}
        </p>
      )}
    </div>
  );
}

const GROUP_ORDER: Array<"critical" | "warning" | "info"> = ["critical", "warning", "info"];
const GROUP_LABELS: Record<string, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};
const GROUP_BADGE: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400",
  warning: "bg-yellow-500/20 text-yellow-400",
  info: "bg-blue-500/20 text-blue-400",
};

// channel_capacity is shown inline inside the network_saturation card
const CHANNEL_CAPACITY_META: FieldDef = { key: "threshold", label: "Channel capacity", unit: "Mbps", min: 1 };

// ── Components ────────────────────────────────────────────────────────────────

interface AlertCardProps {
  setting: AlertSetting;
  channelCapacity?: AlertSetting;
  onToggle: (key: string, enabled: number) => void;
  onFieldBlur: (key: string, field: "threshold" | "threshold2" | "cooldown_min", value: number | null) => void;
}

function AlertCard({ setting, channelCapacity, onToggle, onFieldBlur }: AlertCardProps) {
  const [expanded, setExpanded] = useState(false);
  const meta = ALERT_META[setting.alert_key];
  if (!meta) return null;

  const isOn = setting.enabled === 1;

  return (
    <div className="bg-tg-secondary rounded-xl overflow-hidden">
      {/* Header row */}
      <div
        className="flex items-center gap-3 p-4 cursor-pointer select-none"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-tg truncate">{meta.name}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${GROUP_BADGE[meta.group]}`}>
              {GROUP_LABELS[meta.group]}
            </span>
          </div>
          <p className="text-xs text-tg-hint mt-0.5 leading-snug">{meta.description}</p>
        </div>
        {/* Toggle */}
        <button
          className={`relative w-11 h-6 rounded-full flex-shrink-0 overflow-hidden transition-colors ${isOn ? "bg-tg-button" : "bg-tg-hint/30"}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(setting.alert_key, isOn ? 0 : 1);
          }}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${isOn ? "left-[22px]" : "left-0.5"}`}
          />
        </button>
        {/* Expand indicator */}
        <span className="text-tg-hint text-sm font-bold flex-shrink-0 w-4 text-center leading-none">
          {expanded ? "−" : "+"}
        </span>
      </div>

      {/* Expanded fields */}
      {expanded && (
        <div className="border-t border-tg-hint/10 px-4 py-3 space-y-3">
          {meta.fields.map((field) => {
            const val = setting[field.key] as number | null;
            return (
              <ThresholdField
                key={`${field.key}-${val ?? ""}`}
                def={field}
                value={val}
                onBlur={(v) => onFieldBlur(setting.alert_key, field.key, v)}
              />
            );
          })}
          {/* Channel capacity inline for network_saturation */}
          {setting.alert_key === "network_saturation" && channelCapacity && (
            <ThresholdField
              key={`channel_capacity-${channelCapacity.threshold ?? ""}`}
              def={CHANNEL_CAPACITY_META}
              value={channelCapacity.threshold}
              onBlur={(val) => onFieldBlur("channel_capacity", "threshold", val)}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface ThresholdFieldProps {
  def: FieldDef;
  value: number | null;
  onBlur: (val: number | null) => void;
}

function ThresholdField({ def, value, onBlur }: ThresholdFieldProps) {
  const [local, setLocal] = useState(value !== null ? String(value) : "");

  return (
    <div className="flex items-center justify-between gap-3">
      <label className="text-xs text-tg-hint">{def.label}</label>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          className="w-20 px-2 py-1 rounded-lg text-sm text-right border border-tg focus:outline-none"
          style={{
            backgroundColor: "var(--tg-secondary-bg)",
            color: "var(--tg-text)",
            WebkitTextFillColor: "var(--tg-text)",
          }}
          value={local}
          min={def.min}
          step={def.step ?? 1}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => {
            const n = parseFloat(local);
            onBlur(isNaN(n) ? null : n);
          }}
        />
        <span className="text-xs text-tg-hint w-10">{def.unit}</span>
      </div>
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function Settings() {
  const { haptic } = useTelegram();
  const queryClient = useQueryClient();
  const [downloading, setDownloading] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);

  const { data: dbInfo } = useQuery({
    queryKey: ["dbInfo"],
    queryFn: fetchDbInfo,
  });

  const { data: backupConfig } = useQuery({
    queryKey: ["backupConfig"],
    queryFn: fetchBackupConfig,
  });

  const backupConfigMutation = useMutation({
    mutationFn: patchBackupConfig,
    onSuccess: (updated) => {
      queryClient.setQueryData(["backupConfig"], updated);
      haptic.impact("light");
    },
  });

  const { data: alertData } = useQuery({
    queryKey: ["alertSettings"],
    queryFn: fetchAlertSettings,
  });

  const patchMutation = useMutation({
    mutationFn: ({ key, body }: { key: string; body: Parameters<typeof patchAlertSetting>[1] }) =>
      patchAlertSetting(key, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alertSettings"] });
    },
  });

  const handleToggle = (key: string, enabled: number) => {
    haptic.impact("light");
    patchMutation.mutate({ key, body: { enabled } });
  };

  const handleFieldBlur = (
    key: string,
    field: "threshold" | "threshold2" | "cooldown_min",
    value: number | null
  ) => {
    patchMutation.mutate({ key, body: { [field]: value } });
  };

  const handleBackup = async () => {
    haptic.impact("medium");
    setDownloading(true);
    setBackupError(null);
    try {
      await downloadBackup();
    } catch (err) {
      setBackupError((err as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  const alerts = alertData?.alerts ?? [];
  const settingsByKey = Object.fromEntries(alerts.map((a) => [a.alert_key, a]));
  const channelCapacity = settingsByKey["channel_capacity"];

  return (
    <Layout backTo="/" title="Settings">
      <div className="space-y-4">
        {/* Backup card */}
        <div className="bg-tg-secondary rounded-xl p-4">
          <h2 className="font-medium text-sm text-tg mb-1">Database Backup</h2>
          <p className="text-xs text-tg-hint mb-3">
            Encrypted backups run daily and are sent to the admin chat. Restore from
            the bot by sending a bundle back to the chat.
            {dbInfo && (
              <span className="block mt-1">Size: {formatBytes(dbInfo.size)}</span>
            )}
            <span className="block mt-1">{lastBackupLabel(dbInfo?.lastBackup ?? null)}</span>
          </p>
          <button
            onClick={handleBackup}
            disabled={downloading}
            className="w-full px-4 py-3 rounded-xl bg-tg-button text-tg-button font-medium text-sm disabled:opacity-60"
          >
            {downloading ? "Downloading…" : "💾 Download DB Snapshot"}
          </button>
          {backupError && (
            <p className="mt-2 text-xs text-tg-destructive">{backupError}</p>
          )}
          {backupConfig && (
            <BackupSchedule
              config={backupConfig}
              saving={backupConfigMutation.isPending}
              onChange={(patch) => backupConfigMutation.mutate(patch)}
            />
          )}
        </div>

        {/* Alert settings */}
        {alerts.length > 0 && (
          <div className="space-y-2">
            <h2 className="font-medium text-sm text-tg px-1">Alert Settings</h2>
            {GROUP_ORDER.map((group) => {
              const groupAlerts = alerts.filter(
                (a) => ALERT_META[a.alert_key]?.group === group
              );
              if (groupAlerts.length === 0) return null;
              return (
                <div key={group} className="space-y-2">
                  {groupAlerts.map((setting) => (
                    <AlertCard
                      key={setting.alert_key}
                      setting={setting}
                      channelCapacity={setting.alert_key === "network_saturation" ? channelCapacity : undefined}
                      onToggle={handleToggle}
                      onFieldBlur={handleFieldBlur}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}
